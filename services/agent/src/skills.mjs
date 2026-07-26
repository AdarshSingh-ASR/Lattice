import { readFile } from "node:fs/promises";
import path from "node:path";

const SKILL_FILES = [
  "designing-application-transactions.SKILL.md",
  "hardening-user-privileges.SKILL.md",
  "reviewing-cluster-health.SKILL.md",
];

let cached;

export async function loadCockroachSkillContext() {
  if (cached) return cached;

  const skills = await Promise.all(
    SKILL_FILES.map(async (file) => {
      const fullPath = path.join(process.cwd(), "skills", file);
      const source = await readFile(fullPath, "utf8");
      const name = source.match(/^name:\s*(.+)$/m)?.[1] ?? file;
      const version = source.match(/^\s*version:\s*"?([^"\n]+)"?/m)?.[1] ?? "unknown";
      const guardrails = source
        .split("\n")
        .filter((line) => /retry|idempot|short-lived|least-privilege|prepared|approval|revoke/i.test(line))
        .slice(0, 12)
        .join(" ")
        .slice(0, 2_400);
      return { name, version, source: "cockroachlabs/cockroachdb-skills", guardrails };
    }),
  );

  cached = {
    receipts: skills.map(({ name, version, source }) => ({ name, version, source })),
    prompt: skills.map((skill) => `${skill.name}: ${skill.guardrails}`).join("\n"),
  };
  return cached;
}
