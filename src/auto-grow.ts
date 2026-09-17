/** The parts of a <textarea> that auto-growing needs (an HTMLTextAreaElement has them all). */
export interface GrowableBox {
  readonly scrollHeight: number;
  readonly offsetHeight: number;
  readonly clientHeight: number;
  setCssStyles(styles: { height: string }): void;
  addEventListener(type: "input", listener: () => void): void;
}

/** Something that scrolls, whose position is kept while a box is measured. */
export interface Scroller {
  scrollTop: number;
}

/**
 * Makes a comment box grow with its text. The box's `rows` attribute is its
 * smallest height, and a `max-height` in CSS is its largest: past that, the
 * box stops growing and scrolls instead. Typing also shrinks it back down.
 */
export function autoGrow(box: GrowableBox, scroller?: Scroller): () => void {
  const fit = (): void => {
    const scrollTop = scroller?.scrollTop;
    // Measure the text at the box's natural (rows) height.
    box.setCssStyles({ height: "" });
    const content = box.scrollHeight;
    // A box that isn't displayed (a collapsed card) measures 0; leave it at its natural height.
    if (content > 0) {
      // scrollHeight excludes the border; the height set here includes it.
      const border = box.offsetHeight - box.clientHeight;
      box.setCssStyles({ height: `${content + border}px` });
    }
    // Shrinking the box to measure it can pull the sidebar's scroll position up.
    if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
  };
  box.addEventListener("input", fit);
  fit();
  return fit;
}
