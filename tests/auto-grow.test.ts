import { describe, expect, it } from "vitest";
import { autoGrow, type BoxHolder, type GrowableBox } from "../src/auto-grow";

/** The element around a box, recording the min-heights it's given. */
class FakeHolder implements BoxHolder {
  offsetHeight = 500;
  minHeight = "";
  minHeightsSet: string[] = [];
  setCssStyles(styles: { minHeight: string }): void {
    this.minHeight = styles.minHeight;
    this.minHeightsSet.push(styles.minHeight);
  }
}

/**
 * A stand-in for a <textarea> with `border` px of border: with no inline
 * height it sits at its natural (rows) height, and scrollHeight is the larger
 * of that and the text's height. While its text overflows and its scrollbar
 * isn't hidden, the scrollbar narrows the text, which then needs
 * `scrollbarExtra` px more.
 */
class FakeBox implements GrowableBox {
  height = "";
  overflowY = "";
  textHeight: number;
  scrollbarExtra = 0;
  displayed = true;
  heightsSet: string[] = [];
  readonly parentElement = new FakeHolder();
  /** The holder's min-height at each measurement (each time the height is cleared). */
  holderDuringMeasure: string[] = [];
  private listeners: (() => void)[] = [];

  constructor(
    textHeight: number,
    private readonly naturalHeight = 40,
    private readonly border = 2
  ) {
    this.textHeight = textHeight;
  }

  private get innerHeight(): number {
    if (!this.displayed) return 0;
    return this.height ? parseFloat(this.height) - this.border : this.naturalHeight;
  }
  get scrollHeight(): number {
    if (!this.displayed) return 0;
    const scrollbar = this.overflowY !== "hidden" && this.textHeight > this.innerHeight;
    return Math.max(this.innerHeight, this.textHeight + (scrollbar ? this.scrollbarExtra : 0));
  }
  get clientHeight(): number {
    return this.innerHeight;
  }
  get offsetHeight(): number {
    return this.displayed ? this.innerHeight + this.border : 0;
  }
  setCssStyles(styles: { height?: string; overflowY?: string }): void {
    if (styles.overflowY !== undefined) this.overflowY = styles.overflowY;
    if (styles.height === undefined) return;
    this.height = styles.height;
    this.heightsSet.push(styles.height);
    if (styles.height === "") this.holderDuringMeasure.push(this.parentElement.minHeight);
  }
  addEventListener(_type: "input", listener: () => void): void {
    this.listeners.push(listener);
  }
  type(textHeight: number): void {
    this.textHeight = textHeight;
    for (const listener of this.listeners) listener();
  }
}

describe("autoGrow", () => {
  it("fits a box whose text needs more room than its rows, including the border", () => {
    const box = new FakeBox(100);
    autoGrow(box);
    expect(box.height).toBe("102px");
  });

  it("keeps a short text's box at its rows height", () => {
    const box = new FakeBox(10);
    autoGrow(box);
    expect(box.height).toBe("42px");
  });

  it("grows as text is typed and shrinks back when it is deleted", () => {
    const box = new FakeBox(10);
    autoGrow(box);
    box.type(200);
    expect(box.height).toBe("202px");
    box.type(120);
    expect(box.height).toBe("122px");
    box.type(0);
    expect(box.height).toBe("42px");
  });

  it("measures at the natural height each time, so a box never stays stuck at its old size", () => {
    const box = new FakeBox(200);
    autoGrow(box);
    box.type(50);
    // Each fit clears the height before measuring.
    expect(box.heightsSet).toEqual(["", "202px", "", "52px"]);
  });

  it("leaves a box that isn't displayed at its natural height", () => {
    const box = new FakeBox(100);
    box.displayed = false;
    autoGrow(box);
    expect(box.height).toBe("");
  });

  it("returns a fit function for boxes placed after creation", () => {
    const box = new FakeBox(100);
    box.displayed = false;
    const fit = autoGrow(box);
    box.displayed = true;
    fit();
    expect(box.height).toBe("102px");
  });

  it("measures with its scrollbar hidden, so the text wraps as wide as it's shown", () => {
    const box = new FakeBox(100);
    box.scrollbarExtra = 18;
    autoGrow(box);
    expect(box.height).toBe("102px");
    expect(box.overflowY).toBe("");
  });

  it("holds the element around it at its height while measuring, then lets it go", () => {
    const box = new FakeBox(100);
    autoGrow(box);
    box.type(200);
    expect(box.holderDuringMeasure).toEqual(["500px", "500px"]);
    expect(box.parentElement.minHeight).toBe("");
  });
});
