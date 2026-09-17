import { describe, expect, it } from "vitest";
import { autoGrow, type GrowableBox } from "../src/auto-grow";

/**
 * A stand-in for a <textarea> with `border` px of border: with no inline
 * height it sits at its natural (rows) height, and scrollHeight is the larger
 * of that and the text's height.
 */
class FakeBox implements GrowableBox {
  height = "";
  textHeight: number;
  displayed = true;
  heightsSet: string[] = [];
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
    return this.displayed ? Math.max(this.innerHeight, this.textHeight) : 0;
  }
  get clientHeight(): number {
    return this.innerHeight;
  }
  get offsetHeight(): number {
    return this.displayed ? this.innerHeight + this.border : 0;
  }
  setCssStyles(styles: { height: string }): void {
    this.height = styles.height;
    this.heightsSet.push(styles.height);
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

  it("restores the scroller's position after measuring", () => {
    const box = new FakeBox(100);
    const scroller = { scrollTop: 300 };
    // Simulate the sidebar jumping when the box briefly shrinks.
    box.setCssStyles = function (this: FakeBox, styles: { height: string }) {
      FakeBox.prototype.setCssStyles.call(this, styles);
      if (styles.height === "") scroller.scrollTop = 0;
    };
    autoGrow(box, scroller);
    expect(scroller.scrollTop).toBe(300);
    expect(box.height).toBe("102px");
  });
});
