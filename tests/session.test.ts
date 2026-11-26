import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { linkFromRaw } from "../src/core/links";
import type { PageLink } from "../src/core/links";
import { apply, audiencePage, backTarget, forwardTarget, initialState } from "../src/core/session";
import type { Command, DeckContext, SessionState } from "../src/core/session";
import { labelsFor } from "./frames.test";

const rect = { x: 0, y: 0, width: 0.1, height: 0.1 };
const LINKS: Record<number, PageLink[]> = {
  0: [
    linkFromRaw({ rect, destPage: 17 }),
    linkFromRaw({ rect, namedAction: "NextPage" }),
    linkFromRaw({ rect, namedAction: "PrevPage" }),
    linkFromRaw({ rect, namedAction: "FirstPage" }),
    linkFromRaw({ rect, namedAction: "LastPage" }),
    linkFromRaw({ rect, namedAction: "GoBack" }),
    linkFromRaw({ rect, namedAction: "GoForward" }),
    linkFromRaw({ rect, url: "https://example.org/" }),
    linkFromRaw({ rect, namedAction: "Find" }),
  ],
};
// 23 pages: frames with builds 1,3,4,3,2,1,3,5,1 (fixtures/overlays.pdf).
const deck: DeckContext = {
  frames: new FrameIndex(labelsFor([1, 3, 4, 3, 2, 1, 3, 5, 1])),
  linksFor: (page) => LINKS[page],
};

const run = (commands: Command[], from: SessionState = initialState): SessionState =>
  commands.reduce((state, command) => apply(state, command, deck), from);
const at = (page: number): SessionState => ({ ...initialState, committedPage: page });
const next: Command = { name: "next" };
const previous: Command = { name: "previous" };
const back: Command = { name: "back" };
const forward: Command = { name: "forward" };
const goTo = (page: number): Command => ({ name: "goToPage", page });
const follow = (index: number): Command => ({ name: "followLink", page: 0, index });

describe("steps", () => {
  it("next and previous move one page and never touch history", () => {
    const s = run([next, next, previous]);
    expect(s.committedPage).toBe(1);
    expect(s.history).toEqual([]);
    expect(s.forwardHistory).toEqual([]);
  });

  it("stop at both ends and return the same object", () => {
    expect(apply(initialState, previous, deck)).toBe(initialState);
    const last = at(22);
    expect(apply(last, next, deck)).toBe(last);
  });

  it("nextFrame lands on the first build of the next frame", () => {
    expect(run([{ name: "nextFrame" }], at(5)).committedPage).toBe(8);
    expect(run([{ name: "nextFrame" }], at(22)).committedPage).toBe(22);
  });

  it("previousFrame lands on the last build of the previous frame", () => {
    expect(run([{ name: "previousFrame" }], at(5)).committedPage).toBe(3);
    expect(run([{ name: "previousFrame" }], at(0)).committedPage).toBe(0);
  });

  it("frame steps do not push history", () => {
    expect(run([{ name: "nextFrame" }, { name: "nextFrame" }]).history).toEqual([]);
  });
});

describe("jumps and history", () => {
  it("a jump pushes the page it left", () => {
    const s = run([next, goTo(10)]);
    expect(s.committedPage).toBe(10);
    expect(s.history).toEqual([1]);
  });

  it("a jump to the current page does nothing", () => {
    const s = at(4);
    expect(apply(s, goTo(4), deck)).toBe(s);
  });

  it("jumps clamp to the deck and ignore nonsense", () => {
    expect(run([goTo(999)]).committedPage).toBe(22);
    expect(run([goTo(-3)], at(5)).committedPage).toBe(0);
    expect(apply(initialState, goTo(Number.NaN), deck)).toBe(initialState);
  });

  it("goToFrameLabel jumps to the frame's first build", () => {
    const s = run([{ name: "goToFrameLabel", label: "8" }]);
    expect(s.committedPage).toBe(17);
    expect(s.history).toEqual([0]);
    expect(apply(initialState, { name: "goToFrameLabel", label: "nope" }, deck)).toBe(initialState);
  });

  it("back returns to where the jump started, and forward undoes it", () => {
    let s = run([next, goTo(10)]);
    s = apply(s, back, deck);
    expect(s.committedPage).toBe(1);
    expect(s.history).toEqual([]);
    expect(s.forwardHistory).toEqual([10]);
    s = apply(s, forward, deck);
    expect(s.committedPage).toBe(10);
    expect(s.history).toEqual([1]);
    expect(s.forwardHistory).toEqual([]);
  });

  it("showing a few builds at the target still returns to where the jump started", () => {
    const s = run([goTo(17), next, next, back]);
    expect(s.committedPage).toBe(0);
  });

  it("back skips entries for the page already shown", () => {
    // Jump 2 → 10, step back by hand to 2 is impossible, so: jump 2 → 10, then jump 10 → 2 by link.
    let s = run([goTo(10), goTo(0)]); // history [0, 10], at 0
    expect(s.history).toEqual([0, 10]);
    s = run([goTo(10)], s); // history [0, 10, 0], at 10
    s = run([previous, previous, previous, previous, previous, previous, previous, previous, previous, previous], s);
    expect(s.committedPage).toBe(0); // stepped back by hand to where the last jump came from
    expect(backTarget(s)).toBe(10);
    s = apply(s, back, deck);
    expect(s.committedPage).toBe(10);
    expect(s.history).toEqual([0]);
  });

  it("back with only spent entries empties the stack and stays put", () => {
    const s: SessionState = { ...at(3), history: [3, 3] };
    const after = apply(s, back, deck);
    expect(after.committedPage).toBe(3);
    expect(after.history).toEqual([]);
  });

  it("back and forward with empty stacks return the same object", () => {
    expect(apply(initialState, back, deck)).toBe(initialState);
    expect(apply(initialState, forward, deck)).toBe(initialState);
  });

  it("a new jump clears forward history", () => {
    const s = run([goTo(10), back, goTo(5)]);
    expect(s.forwardHistory).toEqual([]);
    expect(forwardTarget(s)).toBeNull();
    expect(s.history).toEqual([0]);
  });
});

describe("links", () => {
  it("GoTo links jump and push history", () => {
    const s = run([follow(0)]);
    expect(s.committedPage).toBe(17);
    expect(s.history).toEqual([0]);
  });

  it("NextPage and PrevPage are steps", () => {
    const s = run([follow(1), follow(1), follow(2)]);
    expect(s.committedPage).toBe(1);
    expect(s.history).toEqual([]);
  });

  it("FirstPage and LastPage are jumps", () => {
    const s = run([follow(4)]);
    expect(s.committedPage).toBe(22);
    expect(run([follow(3)], s).committedPage).toBe(0);
    expect(run([follow(3)], s).history).toEqual([0, 22]);
  });

  it("GoBack and GoForward use the history stacks", () => {
    const s = run([goTo(12), follow(5)]);
    expect(s.committedPage).toBe(0);
    expect(run([follow(6)], s).committedPage).toBe(12);
  });

  it("URI links, other named actions and unknown links do nothing", () => {
    expect(apply(initialState, follow(7), deck)).toBe(initialState);
    expect(apply(initialState, follow(8), deck)).toBe(initialState);
    expect(apply(initialState, follow(99), deck)).toBe(initialState);
    expect(apply(initialState, { name: "followLink", page: 5, index: 0 }, deck)).toBe(initialState);
  });
});

describe("audience mode", () => {
  it("black and white show no page", () => {
    const black = run([{ name: "setAudienceMode", mode: { kind: "black" } }], at(4));
    expect(audiencePage(black)).toBeNull();
    expect(black.committedPage).toBe(4);
  });

  it("freeze holds the audience page while the committed page moves", () => {
    const s = run([{ name: "setAudienceMode", mode: { kind: "frozen", page: 4 } }, next, next], at(4));
    expect(s.committedPage).toBe(6);
    expect(audiencePage(s)).toBe(4);
    expect(audiencePage(run([{ name: "setAudienceMode", mode: { kind: "live" } }], s))).toBe(6);
  });

  it("setting the same mode returns the same object", () => {
    expect(apply(initialState, { name: "setAudienceMode", mode: { kind: "live" } }, deck)).toBe(initialState);
  });
});

it("an empty deck ignores every command", () => {
  const empty: DeckContext = { frames: new FrameIndex([]), linksFor: () => undefined };
  expect(apply(initialState, next, empty)).toBe(initialState);
  expect(apply(initialState, goTo(3), empty)).toBe(initialState);
});
