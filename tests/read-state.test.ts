import { describe, expect, it } from "vitest";
import type { Comment, Thread } from "../src/model";
import {
  commentKey,
  hasBaseline,
  markRead,
  markUnread,
  mergeReadStates,
  parseReadState,
  pruneNote,
  type ReadState,
  renameNote,
  sameReadState,
  sweep,
  unreadIds,
} from "../src/read-state";

const NOTE = "Plan.md";
const SINCE = "2026-09-18T12:00:00.000Z";
const BEFORE = "2026-09-18T11:00:00Z";
const AFTER = "2026-09-18T13:00:00Z";

function comment(id: string, author: string, timestamp: string, extra: Partial<Comment> = {}): Comment {
  return { id, author, timestamp, text: id, resolved: false, ...extra };
}

function thread(root: Comment, ...replies: Comment[]): Thread {
  return { root, replies: replies.map((r) => ({ ...r, reply_to: root.id })) };
}

function fresh(): ReadState {
  return parseReadState(undefined, new Date(SINCE));
}

describe("parseReadState", () => {
  it("begins tracking now when nothing is stored", () => {
    expect(fresh()).toEqual({ since: SINCE, notes: {} });
  });

  it("keeps valid entries and drops malformed ones", () => {
    const state = parseReadState(
      {
        since: SINCE,
        notes: {
          [NOTE]: { a: { seen: ["1234abcd", 5], at: 7 }, b: "nope", c: { seen: [], unread: true, at: 9 } },
          "Empty.md": { x: null },
          "Bad.md": [],
        },
      },
      new Date(AFTER)
    );
    expect(state).toEqual({
      since: SINCE,
      notes: { [NOTE]: { a: { seen: ["1234abcd"], at: 7 }, c: { seen: [], unread: true, at: 9 } } },
    });
  });
});

describe("commentKey", () => {
  it("is 8 hex digits and stable", () => {
    expect(commentKey("0818f29c-400a-4124-8420-185d6fdc18fa")).toMatch(/^[0-9a-f]{8}$/);
    expect(commentKey("a")).toBe(commentKey("a"));
    expect(commentKey("a")).not.toBe(commentKey("b"));
  });
});

describe("unreadIds", () => {
  it("counts comments by others since tracking began as unread", () => {
    const t = thread(comment("r", "Claude", AFTER), comment("x", "Adam", AFTER), comment("y", "Claude", AFTER));
    expect([...unreadIds(fresh(), NOTE, t, "Adam")]).toEqual(["r", "y"]);
  });

  it("counts comments from before tracking began as read", () => {
    const t = thread(comment("r", "Claude", BEFORE), comment("y", "Claude", AFTER));
    expect([...unreadIds(fresh(), NOTE, t, "Adam")]).toEqual(["y"]);
  });

  it("has nothing unread in a resolved thread", () => {
    const t = thread(comment("r", "Claude", AFTER, { resolved: true }));
    expect(unreadIds(fresh(), NOTE, t, "Adam").size).toBe(0);
  });
});

describe("markRead", () => {
  it("records everyone else's comments in the thread, and reports whether anything changed", () => {
    const state = fresh();
    const t = thread(comment("r", "Claude", BEFORE), comment("x", "Adam", AFTER), comment("y", "Claude", AFTER));
    expect(markRead(state, NOTE, t, "Adam", 1)).toBe(true);
    // Even "r", from before tracking began, so the entry holds after a merge with an earlier start.
    expect(state.notes[NOTE].r).toEqual({ seen: [commentKey("r"), commentKey("y")], at: 1 });
    expect(unreadIds(state, NOTE, t, "Adam").size).toBe(0);
    expect(markRead(state, NOTE, t, "Adam", 2)).toBe(false);
  });

  it("shows a later reply as new", () => {
    const state = fresh();
    const before = thread(comment("r", "Claude", AFTER));
    markRead(state, NOTE, before, "Adam");
    const after = thread(comment("r", "Claude", AFTER), comment("y", "Claude", AFTER));
    expect([...unreadIds(state, NOTE, after, "Adam")]).toEqual(["y"]);
  });

  it("stores nothing for a thread that has only your own comments", () => {
    const state = fresh();
    expect(markRead(state, NOTE, thread(comment("r", "Adam", AFTER)), "Adam")).toBe(false);
    expect(state.notes).toEqual({});
  });
});

describe("markUnread", () => {
  it("makes every comment by someone else new, however old, until read again", () => {
    const state = fresh();
    const t = thread(comment("r", "Claude", BEFORE), comment("x", "Adam", AFTER));
    markUnread(state, NOTE, "r", 1);
    expect([...unreadIds(state, NOTE, t, "Adam")]).toEqual(["r"]);
    expect(markRead(state, NOTE, t, "Adam", 2)).toBe(true);
    expect(unreadIds(state, NOTE, t, "Adam").size).toBe(0);
  });
});

describe("pruneNote", () => {
  it("drops entries for resolved and deleted threads, and keys of deleted comments", () => {
    const state = fresh();
    const kept = thread(comment("a", "Claude", AFTER), comment("a1", "Claude", AFTER), comment("a2", "Claude", AFTER));
    markRead(state, NOTE, kept, "Adam");
    markRead(state, NOTE, thread(comment("b", "Claude", AFTER)), "Adam");
    markRead(state, NOTE, thread(comment("c", "Claude", AFTER)), "Adam");
    const now = [
      thread(comment("a", "Claude", AFTER), comment("a2", "Claude", AFTER)),
      thread(comment("b", "Claude", AFTER, { resolved: true })),
    ];
    expect(pruneNote(state, NOTE, now, "Adam")).toBe(true);
    expect(Object.keys(state.notes[NOTE])).toEqual(["a"]);
    expect(state.notes[NOTE].a.seen).toEqual([commentKey("a"), commentKey("a2")]);
    expect(pruneNote(state, NOTE, now, "Adam")).toBe(false);
  });

  it("drops an entry once no one else's comments are left in its thread, even one marked unread", () => {
    const state = fresh();
    const t = thread(comment("a", "Adam", AFTER), comment("a1", "Claude", AFTER));
    markRead(state, NOTE, t, "Adam");
    markUnread(state, NOTE, "b");
    const now = [thread(comment("a", "Adam", AFTER)), thread(comment("b", "Adam", AFTER))];
    expect(pruneNote(state, NOTE, now, "Adam")).toBe(true);
    expect(state.notes).toEqual({});
  });

  it("drops the note once none of its threads need an entry", () => {
    const state = fresh();
    markRead(state, NOTE, thread(comment("a", "Claude", AFTER)), "Adam");
    pruneNote(state, NOTE, [], "Adam");
    expect(state.notes).toEqual({});
  });
});

describe("renameNote and sweep", () => {
  it("follows a renamed note and forgets notes that no longer exist", () => {
    const state = fresh();
    markRead(state, NOTE, thread(comment("a", "Claude", AFTER)), "Adam");
    markRead(state, "Gone.md", thread(comment("g", "Claude", AFTER)), "Adam");
    expect(renameNote(state, NOTE, "Moved.md")).toBe(true);
    expect(renameNote(state, "Nothing.md", "Else.md")).toBe(false);
    expect(sweep(state, (path) => path === "Moved.md")).toBe(true);
    expect(Object.keys(state.notes)).toEqual(["Moved.md"]);
  });
});

describe("mergeReadStates", () => {
  const t = thread(comment("r", "Claude", AFTER), comment("y", "Claude", AFTER));

  it("treats a comment read on either device as read", () => {
    const local = fresh();
    const remote = fresh();
    markRead(local, NOTE, thread(comment("r", "Claude", AFTER)), "Adam", 1);
    markRead(remote, NOTE, t, "Adam", 2);
    const merged = mergeReadStates(local, remote);
    expect(unreadIds(merged, NOTE, t, "Adam").size).toBe(0);
    expect(merged.notes[NOTE].r.at).toBe(2);
  });

  it("keeps whichever of read and unread happened last", () => {
    const readLater = fresh();
    const unreadEarlier = fresh();
    markUnread(unreadEarlier, NOTE, "r", 1);
    markRead(readLater, NOTE, t, "Adam", 2);
    expect(unreadIds(mergeReadStates(unreadEarlier, readLater), NOTE, t, "Adam").size).toBe(0);
    markUnread(unreadEarlier, NOTE, "r", 3);
    expect(unreadIds(mergeReadStates(readLater, unreadEarlier), NOTE, t, "Adam").size).toBe(2);
  });

  it("keeps a comment read on the device that began tracking later read after the merge", () => {
    // The later device only counted "r" as read because it predates its own start...
    const later = parseReadState(undefined, new Date(AFTER));
    const t2 = thread(comment("r", "Claude", "2026-09-18T12:30:00Z"), comment("y", "Claude", "2026-09-18T14:00:00Z"));
    markRead(later, NOTE, t2, "Adam", 1);
    // ...but after merging with a device that began at noon, "r" is after the start, and must still be read.
    const merged = mergeReadStates(fresh(), later);
    expect(merged.since).toBe(SINCE);
    expect(unreadIds(merged, NOTE, t2, "Adam").size).toBe(0);
  });

  it("keeps the earlier start of tracking", () => {
    const later = parseReadState(undefined, new Date(AFTER));
    expect(mergeReadStates(later, fresh()).since).toBe(SINCE);
  });
});

describe("hasBaseline", () => {
  it("needs a valid start of tracking", () => {
    expect(hasBaseline({ since: SINCE, notes: {} })).toBe(true);
    expect(hasBaseline(undefined)).toBe(false);
    expect(hasBaseline(null)).toBe(false);
    expect(hasBaseline({})).toBe(false);
    expect(hasBaseline({ since: "not a date" })).toBe(false);
  });
});

describe("sameReadState", () => {
  it("ignores the order of notes, threads and keys, but not their contents", () => {
    const a = fresh();
    markRead(a, NOTE, thread(comment("r", "Claude", AFTER), comment("y", "Claude", AFTER)), "Adam", 1);
    markRead(a, "Other.md", thread(comment("o", "Claude", AFTER)), "Adam", 1);
    const b = parseReadState(JSON.parse(JSON.stringify(a)), new Date(AFTER));
    b.notes[NOTE].r.seen.reverse();
    const reordered = { since: b.since, notes: { "Other.md": b.notes["Other.md"], [NOTE]: b.notes[NOTE] } };
    expect(sameReadState(a, reordered)).toBe(true);
    markUnread(b, NOTE, "r", 2);
    expect(sameReadState(a, b)).toBe(false);
  });
});
