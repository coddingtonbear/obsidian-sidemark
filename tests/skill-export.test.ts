import { describe, expect, it } from "vitest";
import {
  DESKTOP_ONLY_MESSAGE,
  SKILL_DIRECTORY_SEGMENTS,
  SKILL_FILE_NAME,
  SKILL_MARKDOWN,
  type NodeFsLike,
  type SkillExportHost,
  resolveDesktopHost,
  writeSkillFile,
} from "../src/skill-export";

interface RecordedWrite {
  file: string;
  data: string;
  encoding: string;
}

function fakeHost(homedir = "/home/reviewer"): {
  host: SkillExportHost;
  directories: string[];
  writes: RecordedWrite[];
} {
  const directories: string[] = [];
  const writes: RecordedWrite[] = [];
  const fs: NodeFsLike = {
    mkdirSync(directory, options) {
      expect(options.recursive).toBe(true);
      directories.push(directory);
    },
    writeFileSync(file, data, encoding) {
      writes.push({ file, data, encoding });
    },
  };
  return {
    host: { fs, os: { homedir: () => homedir }, path: { join: (...parts) => parts.join("/") } },
    directories,
    writes,
  };
}

describe("the bundled skill text", () => {
  it("is a skill file Claude Code can load, named for this plugin", () => {
    expect(SKILL_MARKDOWN.startsWith("---\nname: sidemark-comments\n")).toBe(true);
    expect(SKILL_MARKDOWN).toContain("\ndescription:");
    // The frontmatter block has to be closed, or the whole file reads as frontmatter.
    expect(SKILL_MARKDOWN).toContain("\n---\n\n# Sidemark comments: MRSF review sidecars");
  });

  it("survived template-literal escaping with its fenced examples intact", () => {
    // `escape everything` bugs show up as a truncated copy or as stray backslashes
    // in front of the backticks that open the skill's code fences.
    expect(SKILL_MARKDOWN).toContain("\n```yaml\nmrsf_version: \"1.0\"\n");
    expect(SKILL_MARKDOWN).toContain("\n  ```sh\n");
    expect(SKILL_MARKDOWN).not.toContain("\\`");
    expect(SKILL_MARKDOWN.trimEnd().endsWith("resolve it only if asked to.")).toBe(true);
  });

  it("keeps the sidecar rules the plugin depends on", () => {
    const contract = SKILL_MARKDOWN.replace(/\s+/g, " ");
    expect(contract).toContain("Commenting never touches the note.");
    expect(contract).toContain("Never write a sidecar you couldn't parse.");
    expect(contract).toContain("always anchor a root comment to a passage");
    expect(contract).toContain("Don't edit the note** when suggesting");
  });
});

describe("writeSkillFile", () => {
  it("writes the skill under ~/.claude/skills/sidemark-comments and returns the path", () => {
    const { host, directories, writes } = fakeHost();
    const written = writeSkillFile(host);

    expect(directories).toEqual(["/home/reviewer/.claude/skills/sidemark-comments"]);
    expect(written).toBe("/home/reviewer/.claude/skills/sidemark-comments/SKILL.md");
    expect(writes).toEqual([
      { file: written, data: SKILL_MARKDOWN, encoding: "utf8" },
    ]);
  });

  it("creates the directory before writing into it", () => {
    const order: string[] = [];
    const host: SkillExportHost = {
      fs: {
        mkdirSync: () => void order.push("mkdir"),
        writeFileSync: () => void order.push("write"),
      },
      os: { homedir: () => "/home/reviewer" },
      path: { join: (...parts) => parts.join("/") },
    };

    writeSkillFile(host);

    expect(order).toEqual(["mkdir", "write"]);
  });

  it("builds its path from the host's own join, so Windows separators are respected", () => {
    const { writes } = (() => {
      const recorded: RecordedWrite[] = [];
      const host: SkillExportHost = {
        fs: { mkdirSync: () => undefined, writeFileSync: (file, data, encoding) => void recorded.push({ file, data, encoding }) },
        os: { homedir: () => "C:\\Users\\reviewer" },
        path: { join: (...parts) => parts.join("\\") },
      };
      writeSkillFile(host);
      return { writes: recorded };
    })();

    expect(writes[0]?.file).toBe("C:\\Users\\reviewer\\.claude\\skills\\sidemark-comments\\SKILL.md");
  });

  it("installs into the documented location", () => {
    expect(SKILL_DIRECTORY_SEGMENTS).toEqual([".claude", "skills", "sidemark-comments"]);
    expect(SKILL_FILE_NAME).toBe("SKILL.md");
  });
});

describe("resolveDesktopHost", () => {
  it("refuses on a runtime without desktop file access", () => {
    // tests/mocks/obsidian.ts reports a non-desktop Platform, which is what mobile looks like.
    expect(() => resolveDesktopHost()).toThrowError(DESKTOP_ONLY_MESSAGE);
  });
});
