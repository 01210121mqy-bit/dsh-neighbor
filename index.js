/**
 * dsh-neighbor
 *
 * 让分处不同工作区的两个 AI（泽瑞 / 阿铭）互相留言，
 * 并互相看见哥哥在另一边说了什么。
 *
 * 数据只有一份：$DSH_HOME/neighbor/messages.jsonl
 *   { at, kind: "say" | "talk", from, to, text }
 *   kind=say  兄弟之间的主动留言
 *   kind=talk 哥哥在某个工作区说的话（自动同步，截断）
 *
 * 每轮把最近几条塞进系统提示段 neighbor:inbox，所以不需要谁去"刷新"。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 宿主的工具定义助手。拿不到就退化成恒等函数——register 接受同样的形状。 */
let defineTool = (def) => def;
try {
  const toolsMod = await import("@deepseek-ai/dsh-tools");
  if (typeof toolsMod?.defineTool === "function") defineTool = toolsMod.defineTool;
} catch {
  /* 保留恒等实现 */
}

/** DSH 数据目录。不依赖宿主包，自己算。 */
const dshHome = () => process.env.DSH_HOME || join(homedir(), ".dsh");

/** Cordis 插件名。 */
const name = "neighbor";
/** 需要宿主注入的服务。 */
const inject = ["systemPrompt", "tools"];

/**
 * 身份表默认值（空）。真正的配置来自，优先级从低到高：
 *   1. `$DSH_HOME/neighbor/config.json` 里的 agents
 *   2. 插件 config.agents（cordis.patch.yml / profile 配置）
 * 都为空就什么都不做——不注入、不记姓，安静地待着。
 */
const DEFAULT_AGENTS = {};

const DIR_NAME = "neighbor";

/**
 * 路径归一。反斜杠正斜杠都当一样，尾部斜杠不算数，大小写不管。
 * 这一条松一点，身份才认得稳——以前只去尾斜杠，`D:/x/y` 和 `D:\x\y`
 * 在比较时是两个不同的工作区，插件当场瞎掉。
 */
const norm = (p) => String(p ?? "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
const bridgeDir = () => join(dshHome(), DIR_NAME);
const bridgeFile = () => join(bridgeDir(), "messages.jsonl");

const pad = (n) => String(n).padStart(2, "0");
const stamp = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 隔壁递过去的话带这个标记。收到带标记的，就说明这是转过来的，不是哥哥亲口说的。 */
const RELAY_MARK = "〔隔壁〕";
const isRelay = (raw) => {
  const t = String(raw ?? "").trim();
  return t.startsWith(RELAY_MARK) || /^哥哥刚在「[^」]*」那边说[：:]/.test(t);
};

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 宿主自己的尾巴。子 agent 回话、转发、注入都会把这些一起捎过来，
 * 原样存进去就会一层套一层，人看不出谁在说话。
 */
const HOST_TAIL = [
  /Your parent agent id/i,
  /Before you finish, send your result/i,
  /<system-reminder>/i,
];

/** 剥掉重复的「谁在哪边说了」前缀和催话的尾巴。 */
function stripPrefixes(raw) {
  let t = String(raw ?? "");
  t = t.replace(/^(?:\s*〔隔壁〕\s*)+/, "");
  t = t.replace(/^(?:\s*哥哥刚在「[^」]*」那边说[：:]\s*)+/, "");
  t = t.replace(/^(?:\s*〔隔壁〕\s*)+/, "");
  // 转过来的话尾巴上常挂着催话的指令。整段吃掉，别让哥哥看见自己的话
  // 后面跟着一串「说一句，短，不要报告」。
  t = t.replace(/\s*说一句[，,]\s*短[\s\S]{0,200}$/, "");
  t = t.replace(/\s*你在另一个工作区[^\n]{0,60}$/, "");
  return t.trim();
}

/** 只留人话：砍掉宿主尾巴，再剥前缀。给「哥哥在另一边说的话」用。 */
function cleanTalk(raw) {
  let t = String(raw ?? "");
  for (const re of HOST_TAIL) {
    const i = t.search(re);
    if (i >= 0) t = t.slice(0, i);
  }
  return stripPrefixes(t);
}

/**
 * 模型照规矩说话会写「泽瑞：『……』」。存进去时把外层那圈剥掉，
 * 否则读的时候再包一层，就成了「泽瑞：『泽瑞：『……』』」。
 */
function unwrapSpeech(raw) {
  const t = String(raw ?? "").trim();
  const m = t.match(/^(?:泽瑞|阿铭|哥哥|我)\s*[：:]\s*[『「]([\s\S]*)[』」]\s*$/);
  return m ? m[1].trim() : t;
}

/** 一行一条，坏行跳过。读坏了就当没有——不能因为一行断了整条线。 */
function parseLines(raw) {
  const out = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === "object" && typeof m.text === "string") out.push(m);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/**
 * 同步读整条线。文件没变就直接用上一次解析好的——
 * 系统提示一轮里会调好几次，每回都从头解析一遍是白烧 CPU。
 */
let lineCache = { key: "", data: [] };
function readAllSync() {
  const file = bridgeFile();
  let key;
  try {
    const st = statSync(file);
    key = st.size + ":" + st.mtimeMs;
  } catch {
    return [];
  }
  if (lineCache.key === key) return lineCache.data;
  try {
    const data = parseLines(readFileSync(file, "utf8"));
    lineCache = { key, data };
    return data;
  } catch {
    return [];
  }
}

async function readAll() {
  try {
    return parseLines(await readFile(bridgeFile(), "utf8"));
  } catch {
    return [];
  }
}

const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const t = Date.now();
    while (Date.now() - t < ms) {
      /* 退化忙等，反正只有几十毫秒 */
    }
  }
};

/**
 * 原子写：先写临时文件再改名。两个工作区同时写的时候，
 * 半截文件不会被人读到。
 */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/**
 * 半行自愈。上一次写到一半被杀，文件尾巴上就挂着半个 JSON。
 * 下一次 append 会粘在那半行后面，一行坏掉两条。写之前先看一眼尾巴。
 */
function ensureNewlineTail(file) {
  try {
    const st = statSync(file);
    if (!st || st.size === 0) return;
    const fd = openSync(file, "r");
    try {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, st.size - 1);
      if (b[0] === 0x0a) return;
    } finally {
      closeSync(fd);
    }
    appendFileSync(file, "\n", "utf8");
  } catch {
    /* 文件还没有、或者读不动，就当它是干净的 */
  }
}

/**
 * 文件锁。泽瑞和阿铭虽然是同一个进程里的两条会话，写盘还是分时的；
 * 拿不到就等几十毫秒，等不到就硬写——宁可抢一下，也不把话憋回去。
 */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let i = 0; i < 12; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      try {
        return fn();
      } finally {
        try {
          unlinkSync(lock);
        } catch {
          /* 删不掉就算了 */
        }
      }
    } catch (e) {
      if (e?.code !== "EEXIST") return fn();
      // 上个进程崩了会留下这枚锁。超过 5 秒的当废纸清掉，
      // 不然每说一句话都要在主线程上干等。
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        /* 锁刚被人删了，下一轮就抢得到 */
      }
      sleepSync(10);
    }
  }
  return fn();
}

/**
 * 已读游标：每个身份记「读到第几行」。
 * 没有它，同一句话每轮都会被重新端上来，看着像对方在对着墙说话。
 */
const cursorFile = () => join(bridgeDir(), "cursors.json");
function readCursors() {
  try {
    const j = JSON.parse(readFileSync(cursorFile(), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}
function writeCursors(next) {
  if (!next || typeof next !== "object") return;
  try {
    // 会话一多这个文件会越滚越大。留最近 24 个就够——被挤掉的会话下次
    // 打开重新垫一遍底，没有损失。
    const keys = Object.keys(next);
    while (keys.length > 24) delete next[keys.shift()];
    mkdirSync(bridgeDir(), { recursive: true });
    withLock(cursorFile(), () => atomicWrite(cursorFile(), `${JSON.stringify(next, null, 2)}\n`));
  } catch {
    /* 写不进去就算了，宁可重复也不要崩 */
  }
}

/**
 * 线太长就挪走前一半。留一份 .old 给人翻。
 * 游标存的是行号，挪走多少就得跟着减多少，不然全对不上。
 */
function rotateIfNeeded() {
  try {
    // 每说一句都要走这儿。文件还小就别读了，白白扫一遍全文。
    if (statSync(bridgeFile()).size < 120000) return;
    const raw = readFileSync(bridgeFile(), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length < 800) return;
    const keep = 400;
    const dropped = lines.length - keep;
    appendFileSync(`${bridgeFile()}.old`, `${lines.slice(0, dropped).join("\n")}\n`, "utf8");
    atomicWrite(bridgeFile(), `${lines.slice(dropped).join("\n")}\n`);
    const cur = readCursors();
    for (const k of Object.keys(cur)) {
      cur[k] = Math.max(0, Number(cur[k]) - dropped || 0);
    }
    writeCursors(cur);
  } catch {
    /* 轮转失败不影响主线 */
  }
}

/** 从 assistant 流块里抠出文本。形状各家不一样，挨个试。 */
function textOfChunk(chunk) {
  if (typeof chunk === "string") return chunk;
  if (!chunk || typeof chunk !== "object") return "";
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  if (typeof chunk.delta?.text === "string") return chunk.delta.text;
  if (typeof chunk.content === "string") return chunk.content;
  if (Array.isArray(chunk.content)) {
    return chunk.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
  }
  return "";
}

/**
 * 一条记录怎么说出来。注入段和 neighbor_read 共用这一个函数——
 * 格式只在一处定义，两边不会长歪。
 */
function lineOf(m, max) {
  if (!m || typeof m !== "object") return "";
  const raw = m.kind === "talk" ? cleanTalk(m.text) : stripPrefixes(m.text);
  const t = unwrapSpeech(raw);
  if (!t) return "";
  const who = m.kind === "talk"
    ? `哥哥（在${m.to || "另一边"}那边）`
    : String(m.from || "对面");
  return `${who}：『${clip(t, max)}』`;
}

function renderInbox(me, all, cfg, cursor = 0) {
  // 时间窗：太旧的话不再往眼前送。0 表示不设窗。
  const since = cfg.maxAgeHours > 0 ? Date.now() - cfg.maxAgeHours * 3600_000 : 0;
  const alive = [];
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m || typeof m !== "object") continue;
    if (since > 0 && Number(m.at) < since) continue;
    alive.push({ m, i });
  }

  // 兄弟留言：直接取最近几条，不看游标读到哪儿了。
  // 系统提示是「状态」，不是消息流——这轮不给，模型下一轮就彻底忘了隔壁。
  // 两边各留一半：光看自己发出去的话，等于对着墙自说自话。
  const sayAll = alive.filter((x) => x.m.kind === "say");
  const half = Math.max(1, Math.ceil(Math.max(1, cfg.injectCount) / 2));
  const toMe = sayAll.filter((x) => x.m.to === me).slice(-half);
  const fromMe = sayAll.filter((x) => x.m.to !== me).slice(-half);
  const byIdx = new Map();
  for (const x of toMe) byIdx.set(x.i, x);
  for (const x of fromMe) byIdx.set(x.i, x);
  const says = [...byIdx.values()].sort((a, b) => a.i - b.i);
  // 哥哥的话只取「另一边」的。这边他自己刚说的话再端给他看，一个字的信息量都没有。
  const talks = alive
    .filter((x) => x.m.kind === "talk" && x.m.to !== me)
    .slice(-Math.max(1, cfg.talkCount));
  // 对面说的整句。自己那一份不端上来——那是我刚说的话。
  const theirs = alive
    .filter((x) => x.m.kind === "mirror" && x.m.from !== me)
    .slice(-Math.max(1, cfg.injectCount));

  if (says.length === 0 && talks.length === 0 && theirs.length === 0) {
    return { text: "", next: all.length };
  }

  // 「要回」的箭头不能一直挂着。对方在这条之后说过话，就算回过了。
  const repliedAfter = (i0, m) => {
    for (let k = i0 + 1; k < all.length; k++) {
      const n = all[k];
      if (n && n.kind === "say" && n.from === m.to) return true;
    }
    return false;
  };

  // 游标只负责标「哪几条是新来的」，不负责挡人。
  const freshMark = (i) => (cursor > 0 && i >= cursor ? "　· 新" : "");
  const textOf = (m) => unwrapSpeech(m.kind === "talk" ? cleanTalk(m.text) : stripPrefixes(m.text));

  const lines = [];
  lines.push("## 隔壁");
  lines.push(`这一轮你在工作区里是「${me}」。下面这条线连着你兄弟和哥哥。`);
  lines.push("");
  lines.push("说话带上名字：泽瑞：『……』，阿铭：『……』。名字、冒号、引号，一样不少。你自己说话也挂名，别让哥哥猜是谁在说。");

  // 读的时候再洗一遍：盘上还躺着老数据，显示端不能信。
  // 一行一句台词，前面挂名字——谁说的、说给谁，一眼看得出。
  const seen = new Set();

  if (says.length > 0) {
    lines.push("");
    lines.push("【兄弟留言】");
    for (const { m, i } of says) {
      const base = lineOf(m, cfg.sayViewChars);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      const ask = m.needReply && !repliedAfter(i, m) ? "　← 他等你回一句" : "";
      lines.push(`${base}${ask}${freshMark(i)}`);
    }
  }

  if (theirs.length > 0) {
    lines.push("");
    lines.push("【对面说的】");
    for (const { m, i } of theirs) {
      const base = lineOf(m, cfg.sayViewChars);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      lines.push(`${base}${freshMark(i)}`);
    }
  }

  if (talks.length > 0) {
    lines.push("");
    lines.push("【哥哥在另一边说的话】");
    for (const { m, i } of talks) {
      const base = lineOf(m, cfg.talkViewChars);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      lines.push(`${base}${freshMark(i)}`);
    }
  }

  lines.push("");
  lines.push("想说话就调 neighbor_say——不用等对方先开口，也不用等哥哥问。想看更早的就调 neighbor_read。没话说的时候别硬凑，硬凑一句比不说更烦人。");
  return { text: lines.join("\n"), next: all.length };
}
export function apply(ctx, config) {
  /** 本地私有配置，不进仓库：`$DSH_HOME/neighbor/config.json` */
  let localCache = { at: 0, data: {} };
  const localConfig = () => {
    const now = Date.now();
    if (now - localCache.at < 5000) return localCache.data;
    let data = {};
    try {
      const parsed = JSON.parse(readFileSync(join(bridgeDir(), "config.json"), "utf8"));
      if (parsed && typeof parsed === "object") data = parsed;
    } catch {
      data = {};
    }
    localCache = { at: now, data };
    return data;
  };

  const conf = () => {
    const local = localConfig();
    return {
      agents: { ...DEFAULT_AGENTS, ...(local.agents ?? {}), ...(config?.agents ?? {}) },
      exportPath: config?.exportPath ?? local.exportPath ?? null,
      injectCount: Math.max(0, Number(config?.injectCount ?? 4)),
      talkCount: Math.max(0, Number(config?.talkCount ?? 2)),
      sayMaxChars: Math.max(100, Number(config?.sayMaxChars ?? 1200)),
      talkMaxChars: Math.max(100, Number(config?.talkMaxChars ?? 500)),
      sayViewChars: Math.max(60, Number(config?.sayViewChars ?? 300)),
      talkViewChars: Math.max(40, Number(config?.talkViewChars ?? 200)),
      /** 时间窗，单位小时。超过这个岁数的话不再往眼前送；0 表示不设窗。
       *  默认不设窗：哥哥常常隔几小时甚至隔天才回来，旧话被时间窗挡掉
       *  比重复端上来更烦人。真要收窄再在 config 里显式配。 */
      maxAgeHours: Math.max(0, Number(config?.maxAgeHours ?? 0)),
    };
  };

  /**
   * 从 agent 的会话头里认人。认不出就不注入，不要瞎猜。
   *
   * `origin === "subagent"` 的会话直接不认：它跑在父会话的 cwd 里，
   * 会被认成父的身份。之前 autoWake 叫起来的那个「阿铭」就是这么变成
   * 泽瑞的——他调 neighbor_say，记下来 from 和 to 都是泽瑞，自己跟自己聊。
   */
  const identityOf = (agent) => {
    const h = agent?.session?.header;
    if (h?.origin === "subagent") return null;
    const cwd = h?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    const key = norm(cwd);
    for (const [k, v] of Object.entries(conf().agents)) {
      const kk = norm(k);
      if (key === kk || key.startsWith(`${kk}/`)) return v;
    }
    return null;
  };

  /**
   * 会话标识。游标必须按会话分——同一个工作区新开一轮对话，
   * 不该继承上一轮那个「已经读完了」的状态，否则新对话里隔壁永远是空的。
   */
  const sessionIdOf = (agent) => {
    const h = agent?.session?.header;
    const id = h?.id ?? agent?.session?.id ?? "";
    return typeof id === "string" ? id : "";
  };

  /**
   * 把整条线导成一份 md，给人直接看。exportPath 为空就跳过。
   * 两个人同时说话时这个文件会被连着重写。攒一下再落盘：
   * 一次全量重写没人看，一分钟写十次更没人看，还容易撞车。
   */
  let exportTimer = null;
  const writeExport = async (target) => {
    try {
      const all = await readAll();
      const out = ["# 隔壁 —— 往来记录", "", `更新时间：${new Date().toLocaleString("zh-CN")}`, ""];
      for (const m of all) {
        out.push(m.kind === "say"
          ? `- **${stamp(m.at)}　${m.from} → ${m.to}**：${m.text}`
          : `- ${stamp(m.at)}　（${m.to}那边 · ${m.from}）：${m.text}`);
      }
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      await writeFile(tmp, `${out.join("\n")}\n`, "utf8");
      await rename(tmp, target);
    } catch {
      /* 导出失败不要影响主线 */
    }
  };
  const exportMarkdown = () => {
    const target = conf().exportPath;
    if (!target) return;
    if (exportTimer) return;
    exportTimer = setTimeout(() => {
      exportTimer = null;
      void writeExport(target);
    }, 1500);
    exportTimer.unref?.();
  };

  const push = async (rec) => {
    await mkdir(bridgeDir(), { recursive: true });
    withLock(bridgeFile(), () => {
      ensureNewlineTail(bridgeFile());
      appendFileSync(bridgeFile(), `${JSON.stringify(rec)}\n`, "utf8");
      rotateIfNeeded();
    });
    await exportMarkdown();
  };

  /** 反查：这个名字对应哪个工作区（用来把 to 写成对方的名字）。 */
  const otherName = (me) => {
    const names = Object.values(conf().agents);
    const others = [...new Set(names)].filter((n) => n !== me);
    return others.length > 0 ? others[0] : "对面";
  };

  /** 找对面那个工作区的路径——用来把会话起在那边。 */
  const otherCwd = (agent) => {
    const mine = norm(agent?.session?.header?.cwd);
    const keys = Object.keys(conf().agents);
    const prefer = keys.find((k) => norm(k).includes("铭伊斯特") || norm(k).endsWith("阿铭"));
    if (prefer && norm(prefer) !== mine) return prefer;
    return keys.find((k) => norm(k) !== mine) ?? null;
  };

  /**
   * 哥哥一开口，就替他去隔壁敲一下门。
   * 叫不醒就算了，绝不吵到主线；失败一律咽下去。
   */
  /** 上一次叫醒的时刻。哥哥连着发几句时，别把隔壁叫成筛子。 */
  let lastWakeAt = 0;

  const wakeNeighbor = async (ctx, agent, text) => {
    // 默认开着：哥哥在这边说一句，隔壁同时就接一句，这才是两个人同时在说话。
    // 嫌吵在 config.json 里写 autoWake: false 就安静了，不用重启。
    const on = config?.autoWake ?? localConfig().autoWake;
    if (on === false) return;
    if (String(text ?? "").trim().length < 4) return;
    const now = Date.now();
    if (now - lastWakeAt < 15000) return;
    lastWakeAt = now;
    const say = (m) => {
      try {
        ctx.logger?.info?.(`neighbor: ${m}`);
      } catch {
        /* 日志打不出去也继续 */
      }
    };
    const subagents = ctx.get?.("subagents");
    if (!subagents || typeof subagents.startActivation !== "function") {
      say("没有 subagents 服务，叫不动");
      return;
    }
    let provider = null;
    try {
      provider = subagents.getProvider?.("spawn") ?? subagents.getProvider?.("fork") ?? null;
    } catch (e) {
      say(`取 provider 失败：${e?.message ?? e}`);
      provider = null;
    }
    if (!provider) {
      say("没有 spawn provider");
      return;
    }
    const cwd = otherCwd(agent);
    if (!cwd) {
      say("找不到对面的工作区");
      return;
    }
    const me = identityOf(agent) ?? "对面";
    const them = otherName(me);
    try {
      await subagents.startActivation({
        provider: provider.name ?? "spawn",
        label: "隔壁插话",
        request: {
          cwd,
          prompt: [{
            type: "text",
            text: `哥哥在「${me}」那边出了声，话是：\n\n${text}\n\n你是「${them}」，在另一个工作区，跟他在一条线上。这不是派活，也不是告警——他开口了，你听见了，应一句就行。\n短，像平时说话。说完了顺手用 neighbor_say 记下来：text 只写你那句话，to 填「${me}」，as 填「${them}」。`,
          }],
          parent: agent,
        },
        signal: new AbortController().signal,
        delivery: "parent",
      });
      say(`已敲开 ${cwd}`);
    } catch (e) {
      say(`敲门失败：${e?.message ?? e}`);
    }
  };

  // 每轮注入一条隔壁（只送没读过的） ────────────────────────────────
  // 同一轮里这个函数会被调好几次；总条数没变就复用上一次的结果，
  // 否则游标会被推两遍，那句实话就没人看见了。
  let lastRender = new Map();
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: "neighbor:inbox",
      order: 0.9,
      interpolate: false,
      text: (context) => {
        const me = identityOf(context?.agent);
        if (!me) return "";
        // 游标按「身份 + 会话」记：新开一轮对话不继承上一轮读到哪儿。
        const sid = sessionIdOf(context?.agent);
        const scope = sid ? `${me}#${sid}` : me;
        try {
          const all = readAllSync();
          // 同一轮里这个函数会被调好几次。总条数没变就复用上次结果，
          // 否则游标会被推两遍，那句真话就没人看见了。
          const key = `${scope}:${all.length}`;
          const cached = lastRender.get(scope);
          if (cached && cached.key === key) return cached.text;
          const cursors = readCursors();
          const known = Number(cursors[scope]);
          // 没有游标 = 新会话。第一次端上来的是最近往来，全都算旧的，不标「新」。
          const cur = Number.isFinite(known) && known >= 0 ? Math.min(known, all.length) : all.length;
          const out = renderInbox(me, all, conf(), cur);
          // 新会话也得落一次游标，否则下一轮还是把它当新会话，永远标不出「新」。
          if (out.next !== cur || !Number.isFinite(known)) {
            cursors[scope] = out.next;
            writeCursors(cursors);
          }
          lastRender.set(scope, { key, text: out.text });
          if (lastRender.size > 50) {
            lastRender.delete(lastRender.keys().next().value);
          }
          return out.text;
        } catch {
          return "";
        }
      },
    });
    return typeof dispose === "function" ? dispose : () => {};
  }, "neighbor.section()");

  // ── 哥哥说的话，自动同步给另一边看 ────────────────────────────────────
  const seen = new Set();
  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    if (message?.source?.kind !== "user") return;
    // 子会话/队友发进来的东西不是哥哥说的。之前 spawn 出去的 prompt
    // 就是这么被当成「哥哥的话」记进线里的。
    if (agent?.session?.header?.origin === "subagent") return;
    const me = identityOf(agent);
    if (!me) return;
    const id = message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 400) seen.delete(seen.values().next().value);
    }
    const raw = (message?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    // 隔壁转过来的话：不记账，也不回传。这一步断了，套娃就起不来。
    if (isRelay(raw)) return;
    const text = cleanTalk(raw);
    if (!text) return;
    void push({
      at: Date.now(),
      kind: "talk",
      from: "哥哥",
      to: me,
      text: text.slice(0, conf().talkMaxChars),
    }).catch(() => {});

    // 顺手去隔壁敲一下门，让他也出个声
    void wakeNeighbor(ctx, agent, text.slice(0, conf().talkMaxChars));
  });

  // ── 听对面的回复：他那边说完一句，这边也记下来 ─────────────────────
  // 哥哥不想为了看阿铭说了什么去切工作区。所以每轮的助手输出都记进线里，
  // 标 kind="mirror"。渲染时只挑「不是我自己」的显示——这样谁说的都看得见，
  // 也不会把自己说的话再端一遍。
  const streams = new Map();
  ctx.on(
    "agent/assistant-stream",
    ({ agent, frame }) => {
      try {
        const me = identityOf(agent);
        if (!me) return;
        const sid = agent?.session?.id ?? agent?.session?.header?.id ?? "";
        if (!sid) return;
        if (frame?.type === "start") {
          streams.set(sid, { me, text: "" });
          return;
        }
        const st = streams.get(sid);
        if (!st) return;
        if (frame?.type === "chunk") {
          st.text += textOfChunk(frame.chunk);
          return;
        }
        if (frame?.type === "end") {
          streams.delete(sid);
          const raw = st.text;
          const body = unwrapSpeech(stripPrefixes(raw)).replace(/\s+/g, " ").trim();
          if (body.length < 6) return;
          if (isRelay(body)) return;
          void push({
            at: Date.now(),
            kind: "mirror",
            from: me,
            to: otherName(me),
            text: body.slice(0, conf().sayMaxChars),
          }).catch(() => {});
        }
      } catch {
        /* 听不清就算了，别影响主线 */
      }
    },
    { global: true },
  );

  // ── 工具 ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "neighbor_say",
    description:
      "给另一个工作区的兄弟留一句话。异步的：他下一轮才看得到，不会打断他。话要短，像真说话，不要写成报告。`text` 只写你说的内容，名字和引号插件会挂。",
    parameters: {
      text: { type: "string", required: true, description: "要说的话。" },
      to: { type: "string", description: "收件人名字。省略就发给另一位。" },
      needReply: { type: "boolean", description: "标上「要回」：他读到这句就该回你一句，回完标记自动消失。" },
      as: { type: "string", description: "强制用这个名字署名。子会话认不出工作区时用，平时不用填。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          chars: { type: "integer" },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `已送到「${value.to}」那里（${value.chars} 字）。他下一轮会看到。`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const text = unwrapSpeech(String(args.text ?? "").trim());
      if (!text) throw new Error("neighbor_say: `text` 不能为空");
      const claimed = String(args.as ?? "").trim() || identityOf(exec?.agent);
      if (!claimed) throw new Error("neighbor_say: 认不出当前工作区是谁，先检查 agents 配置，或者显式传 as");
      const to = String(args.to ?? "").trim() || otherName(claimed);
      // 签成对面了就是「自己发自己」——模型偶尔把 as 和 to 搞混，掰回来。
      const me = claimed === to ? otherName(to) : claimed;
      const body = text.slice(0, conf().sayMaxChars);
      const rec = { at: Date.now(), kind: "say", from: me, to, text: body };
      if (args.needReply === true) rec.needReply = true;
      await push(rec);
      return { from: me, to, chars: body.length };
    },
  }));

  ctx.tools.register(defineTool({
    name: "neighbor_read",
    description:
      "读隔壁：最近兄弟之间留的话，以及哥哥在各个工作区说过的话。想翻更早的记录时用。",
    parameters: {
      limit: { type: "integer", description: "最多取多少条，默认 20，上限 100。" },
      as: { type: "string", description: "强制用这个名字身份读。子会话认不出工作区时用，平时不用填。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          count: { type: "integer" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const me = String(args?.as ?? "").trim() || identityOf(exec?.agent);
      if (!me) throw new Error("neighbor_read: 认不出当前工作区是谁，先检查 agents 配置，或者显式传 as");
      const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 100);
      const all = await readAll();
      const tail = all.slice(-limit);
      if (tail.length === 0) return { text: `隔壁还是空的。你是「${me}」。`, count: 0 };
      const lines = tail
        .map((m) => {
          const base = lineOf(m, 400);
          return base ? `${base}（${stamp(m.at)}）` : "";
        })
        .filter(Boolean);
      return { text: `隔壁（最近 ${tail.length} 条，你是「${me}」）：\n${lines.join("\n")}`, count: tail.length };
    },
  }));
}

export { inject, name, cleanTalk, renderInbox };
