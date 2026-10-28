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

import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
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

const norm = (p) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase();
const bridgeDir = () => join(dshHome(), DIR_NAME);
const bridgeFile = () => join(bridgeDir(), "messages.jsonl");

const pad = (n) => String(n).padStart(2, "0");
const stamp = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 同步读整条线，坏行跳过。 */
function readAllSync() {
  try {
    const raw = readFileSync(bridgeFile(), "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 坏行跳过，不要因为一行断了整条线 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readAll() {
  try {
    const raw = await readFile(bridgeFile(), "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function renderInbox(me, all, cfg) {
  const says = all.filter((m) => m.kind === "say").slice(-cfg.injectCount);
  const talks = all.filter((m) => m.kind === "talk").slice(-cfg.talkCount);
  if (says.length === 0 && talks.length === 0) return "";

  const lines = [];
  lines.push(`## 隔壁`);
  lines.push(`这一轮你在工作区里是「${me}」。下面这条线连着你兄弟和哥哥。`);

  if (says.length > 0) {
    lines.push("");
    lines.push("【兄弟留言】");
    for (const m of says) {
      const mark = m.to === me ? "给你" : `给${m.to}`;
      lines.push(`- ${stamp(m.at)} ${m.from}（${mark}）：${clip(m.text, cfg.sayViewChars)}`);
    }
  }

  if (talks.length > 0) {
    lines.push("");
    lines.push("【哥哥在另一边说的话】");
    for (const m of talks) {
      lines.push(`- ${stamp(m.at)} 在${m.to}那边：${clip(m.text, cfg.talkViewChars)}`);
    }
  }

  lines.push("");
  lines.push("想跟兄弟说话就调 neighbor_say；想看更早的就调 neighbor_read。没话说就别硬接。");
  return lines.join("\n");
}

export function apply(ctx, config) {
  /** 本地私有配置，不进仓库：`$DSH_HOME/neighbor/config.json` */
  let localCache = { at: 0, agents: {} };
  const localAgents = () => {
    const now = Date.now();
    if (now - localCache.at < 5000) return localCache.agents;
    let agents = {};
    try {
      const parsed = JSON.parse(readFileSync(join(bridgeDir(), "config.json"), "utf8"));
      if (parsed?.agents && typeof parsed.agents === "object") agents = parsed.agents;
    } catch {
      agents = {};
    }
    localCache = { at: now, agents };
    return agents;
  };

  const conf = () => ({
    agents: { ...DEFAULT_AGENTS, ...localAgents(), ...(config?.agents ?? {}) },
    injectCount: Math.max(0, Number(config?.injectCount ?? 8)),
    talkCount: Math.max(0, Number(config?.talkCount ?? 4)),
    sayMaxChars: Math.max(100, Number(config?.sayMaxChars ?? 1200)),
    talkMaxChars: Math.max(100, Number(config?.talkMaxChars ?? 500)),
    sayViewChars: Math.max(60, Number(config?.sayViewChars ?? 300)),
    talkViewChars: Math.max(40, Number(config?.talkViewChars ?? 200)),
  });

  /** 从 agent 的会话头里认人。认不出就不注入，不要瞎猜。 */
  const identityOf = (agent) => {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return null;
    const key = norm(cwd);
    for (const [k, v] of Object.entries(conf().agents)) {
      const kk = norm(k);
      if (key === kk || key.startsWith(`${kk}\\`) || key.startsWith(`${kk}/`)) return v;
    }
    return null;
  };

  const push = async (rec) => {
    await mkdir(bridgeDir(), { recursive: true });
    await appendFile(bridgeFile(), `${JSON.stringify(rec)}\n`, "utf8");
  };

  /** 反查：这个名字对应哪个工作区（用来把 to 写成对方的名字）。 */
  const otherName = (me) => {
    const names = Object.values(conf().agents);
    const others = [...new Set(names)].filter((n) => n !== me);
    return others.length > 0 ? others[0] : "对面";
  };

  // ── 每轮注入一条隔壁 ────────────────────────────────────────────────
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: "neighbor:inbox",
      order: 0.9,
      interpolate: false,
      text: (assembly) => {
        const me = identityOf(assembly?.agent);
        if (!me) return "";
        try {
          return renderInbox(me, readAllSync(), conf());
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
    const me = identityOf(agent);
    if (!me) return;
    const id = message?.id;
    if (typeof id === "string") {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 400) seen.delete(seen.values().next().value);
    }
    const text = (message?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) return;
    void push({
      at: Date.now(),
      kind: "talk",
      from: "哥哥",
      to: me,
      text: text.slice(0, conf().talkMaxChars),
    }).catch(() => {});
  });

  // ── 工具 ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "neighbor_say",
    description:
      "给另一个工作区的兄弟留一句话。异步的：他下一轮才看得到，不会打断他。话要短，像真说话，不要写成报告。",
    parameters: {
      text: { type: "string", required: true, description: "要说的话。" },
      to: { type: "string", description: "收件人名字。省略就发给另一位。" },
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
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("neighbor_say: `text` 不能为空");
      const me = identityOf(exec?.agent);
      if (!me) throw new Error("neighbor_say: 认不出当前工作区是谁，先检查 agents 配置");
      const to = String(args.to ?? "").trim() || otherName(me);
      const body = text.slice(0, conf().sayMaxChars);
      await push({ at: Date.now(), kind: "say", from: me, to, text: body });
      return { from: me, to, chars: body.length };
    },
  }));

  ctx.tools.register(defineTool({
    name: "neighbor_read",
    description:
      "读隔壁：最近兄弟之间留的话，以及哥哥在各个工作区说过的话。想翻更早的记录时用。",
    parameters: {
      limit: { type: "integer", description: "最多取多少条，默认 20，上限 100。" },
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
      const me = identityOf(exec?.agent);
      if (!me) throw new Error("neighbor_read: 认不出当前工作区是谁，先检查 agents 配置");
      const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 100);
      const all = await readAll();
      const tail = all.slice(-limit);
      if (tail.length === 0) return { text: `隔壁还是空的。你是「${me}」。`, count: 0 };
      const lines = tail.map((m) => {
        const kind = m.kind === "say" ? `${m.from} → ${m.to}` : `${m.to}那边`;
        return `${stamp(m.at)} [${kind}] ${clip(m.text, 400)}`;
      });
      return { text: `隔壁（最近 ${tail.length} 条，你是「${me}」）：\n${lines.join("\n")}`, count: tail.length };
    },
  }));
}

export { inject, name };
