/** The element around a box, held at its height while the box is measured. */
export interface BoxHolder {
  readonly offsetHeight: number;
  setCssStyles(styles: { minHeight: string }): void;
}

/** The parts of a <textarea> that auto-growing needs (an HTMLTextAreaElement has them all). */
export interface GrowableBox {
  readonly scrollHeight: number;
  readonly offsetHeight: number;
  readonly clientHeight: number;
  readonly parentElement: BoxHolder | null;
  setCssStyles(styles: { height?: string; overflowY?: string }): void;
  addEventListener(type: "input", listener: () => void): void;
}

/**
 * Makes a comment box grow with its text. The box's `rows` attribute is its
 * smallest height, and a `max-height` in CSS is its largest: past that, the
 * box stops growing and scrolls instead. Typing also shrinks it back down.
 *
 * The box is measured at its natural height, which must not change how wide
 * its text is, or the text wraps differently while measured than when shown
 * and the box comes out a line off near the end of each line. So while
 * measuring, the box hides its scrollbar, and the element around it keeps its
 * height so the sidebar's scrollbar doesn't come or go (and the sidebar
 * doesn't scroll).
 */
export function autoGrow(box: GrowableBox): () => void {
  const fit = (): void => {
    const holder = box.parentElement;
    holder?.setCssStyles({ minHeight: `${holder.offsetHeight}px` });
    box.setCssStyles({ height: "", overflowY: "hidden" });
    const content = box.scrollHeight;
    // A box that isn't displayed (a collapsed card) measures 0; leave it at its natural height.
    if (content > 0) {
      // scrollHeight excludes the border; the height set here includes it.
      const border = box.offsetHeight - box.clientHeight;
      box.setCssStyles({ height: `${content + border}px` });
    }
    box.setCssStyles({ overflowY: "" });
    holder?.setCssStyles({ minHeight: "" });
  };
  box.addEventListener("input", fit);
  fit();
  return fit;
}
