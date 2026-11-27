import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { HEARTBEAT_MS, HOST_TIMEOUT_MS, JOIN_WAIT_MS, Peer, outranks } from "../src/core/peer";
import type { Envelope, Message, StateBody, View } from "../src/core/protocol";
import { elapsedMs } from "../src/core/session";
import { labelsFor } from "./frames.test";

/**
 * A simulated talk: peers joined by a relay that delivers every message to every other connected
 * peer, with one clock the test moves. Each device keeps what it was told and what it would draw.
 */
function talk() {
  let now = 1_000_000;
  const devices = new Map<string, Device>();
  interface Device {
    peer: Peer;
    sid: string;
    connected: boolean;
    seq: number;
    delivered: Envelope[];
    pointers: boolean[];
    ended: number;
    changes: number;
    connect(): void;
    drop(): void;
    state(): StateBody | undefined;
    page(): number | undefined;
  }
  const add = (name: string, sid: string, options: { networked?: boolean; connect?: boolean } = {}): Device => {
    const d: Device = {
      sid,
      connected: false,
      seq: 0,
      delivered: [],
      pointers: [],
      ended: 0,
      changes: 0,
      peer: undefined as unknown as Peer,
      connect() {
        d.connected = true;
        d.peer.online(true);
      },
      drop() {
        d.connected = false;
        d.peer.online(false);
      },
      state: () => d.delivered.filter((e) => e.type === "state").map((e) => (e.type === "state" ? e.body : undefined)).at(-1),
      page: () => d.peer.viewState()?.committedPage,
    };
    d.peer = new Peer(
      { frames: new FrameIndex(labelsFor([1, 3, 1, 1])), split: null, linksFor: () => undefined },
      { sid, device: name, deckPublished: "", targetMs: null, networked: options.networked ?? true },
      {
        now: () => now,
        transmit: (message: Message, to?: string) => {
          if (!d.connected) return 0;
          const envelope = { sid, seq: ++d.seq, ...(to ? { to } : {}), ...message } as Envelope;
          for (const other of devices.values()) if (other !== d && other.connected) other.peer.receive(envelope);
          return envelope.seq;
        },
        deliver: (envelope) => d.delivered.push(envelope),
        changed: () => d.changes++,
        pointer: (_x, _y, visible) => d.pointers.push(visible),
        end: () => d.ended++,
        status: () => ({ relay: d.connected ? "connected" : "reconnecting", draw: { count: 0, medianMs: null, lastMs: null, maxMs: null }, cacheMisses: 0 }),
      },
    );
    devices.set(name, d);
    if (options.connect ?? true) d.connect();
    return d;
  };
  /** Moves the clock, ticking every peer along the way as the app does. */
  const wait = (ms: number): void => {
    for (let t = 0; t < ms; t += 250) {
      now += 250;
      for (const d of devices.values()) d.peer.tick();
    }
  };
  const join = (name: string, sid: string, view: View): Device => {
    const d = add(name, sid);
    d.peer.setView(view);
    wait(JOIN_WAIT_MS + 250);
    return d;
  };
  const hosts = (): string[] => [...devices].filter(([, d]) => d.peer.hosting).map(([name]) => name);
  return { add, join, wait, hosts, now: () => now };
}

const next: Message = { type: "command", body: { name: "next" } };
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";

describe("outranks", () => {
  it("prefers the slides screen, then the longer-connected device, then the lower id", () => {
    expect(outranks({ sid: B, view: "audience", since: 9 }, { sid: A, view: "presenter", since: 1 })).toBe(true);
    expect(outranks({ sid: A, view: "presenter", since: 1 }, { sid: B, view: "audience", since: 9 })).toBe(false);
    expect(outranks({ sid: B, view: "presenter", since: 1 }, { sid: A, view: "presenter", since: 9 })).toBe(true);
    expect(outranks({ sid: A, view: "audience", since: 5 }, { sid: B, view: "audience", since: 5 })).toBe(true);
    expect(outranks({ sid: B, view: "audience", since: 5 }, { sid: A, view: "audience", since: 5 })).toBe(false);
  });
});

describe("a talk across devices", () => {
  it("the first device in runs the talk, whatever it shows; it only listens until it has chosen", () => {
    const t = talk();
    const laptop = t.add("Laptop", A);
    t.wait(5000);
    expect(t.hosts()).toEqual([]); // still choosing a view
    laptop.peer.setView("presenter");
    expect(t.hosts()).toEqual(["Laptop"]);
    expect(laptop.state()).toMatchObject({ page: 0, hostView: "presenter", timer: { running: false }, room: { devices: ["Laptop"], audiences: 0 } });
  });

  it("a second device follows, drives the talk, and is counted", () => {
    const t = talk();
    const laptop = t.join("Laptop", A, "presenter");
    const phone = t.join("Phone", B, "presenter");
    expect(t.hosts()).toEqual(["Laptop"]);
    expect(phone.peer.role).toBe("follower");
    expect(phone.peer.send(next)).toBeGreaterThan(0);
    expect(laptop.page()).toBe(1);
    expect(phone.page()).toBe(1);
    expect(phone.state()).toMatchObject({ page: 1, ack: { sid: B } });
    expect(laptop.state()?.room?.devices).toEqual(["Laptop", "Phone"]);
    // The host's own view drives it too, and hears the answer.
    expect(laptop.peer.send(next)).toBeGreaterThan(0);
    expect(phone.page()).toBe(2);
    expect(laptop.state()).toMatchObject({ page: 2, ack: { sid: A } });
  });

  it("a slides screen takes the talk over where it stands: page, history, clock and ink", () => {
    const t = talk();
    const laptop = t.join("Laptop", A, "presenter");
    const phone = t.join("Phone", B, "presenter");
    phone.peer.send({ type: "command", body: { name: "goToPage", page: 4 } });
    phone.peer.send({ type: "command", body: { name: "timerSetTarget", targetMs: 600_000 } });
    phone.peer.send({ type: "ink", body: { op: "begin", id: 1, x: 0.1, y: 0.1, color: 0, width: 3 } });
    phone.peer.send({ type: "ink", body: { op: "append", id: 1, points: [0.2, 0.2, 0.3, 0.3] } });
    t.wait(10_000);

    // The room's computer opens the talk and looks at the choice of views: nothing changes yet.
    const room = t.add("Room PC", C);
    t.wait(3000);
    expect(t.hosts()).toEqual(["Laptop"]);
    expect(room.peer.heard).toMatchObject({ page: 4 });
    expect(laptop.state()?.room?.devices).toEqual(["Laptop", "Phone", "Room PC"]);

    room.peer.setView("audience");
    expect(t.hosts()).toEqual(["Room PC"]);
    const state = room.peer.viewState()!;
    expect(state.committedPage).toBe(4);
    expect(state.history).toEqual([0]);
    expect(state.timer.targetMs).toBe(600_000);
    expect(elapsedMs(state.timer, t.now())).toBeGreaterThanOrEqual(13_000); // running since the jump
    expect(state.ink.page).toHaveLength(1);
    expect(state.ink.page[0]?.points).toEqual([0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);

    // Everyone follows the new host, which counts them and says a screen is showing the slides.
    expect(laptop.peer.role).toBe("follower");
    phone.peer.send(next);
    expect(room.page()).toBe(5);
    expect(laptop.page()).toBe(5);
    t.wait(HEARTBEAT_MS);
    expect(phone.state()).toMatchObject({ hostView: "audience", room: { audiences: 1 } });
    expect([...(phone.state()?.room?.devices ?? [])].sort()).toEqual(["Laptop", "Phone", "Room PC"]);
  });

  it("the slides screen's own keys never wait for the network", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    room.drop();
    room.peer.dispatch({ name: "next" }, 5);
    expect(room.page()).toBe(1);
    expect(room.changes).toBeGreaterThan(0);
  });

  it("a second slides screen follows the first, and shows the pointer", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const overflow = t.join("Overflow", B, "audience");
    const phone = t.join("Phone", C, "presenter");
    expect(t.hosts()).toEqual(["Room PC"]);
    phone.peer.send(next);
    expect(overflow.page()).toBe(1);
    phone.peer.send({ type: "pointer", body: { x: 0.5, y: 0.5, visible: true } });
    expect(room.pointers).toEqual([true]);
    expect(overflow.pointers).toEqual([true]);
    expect(phone.pointers).toEqual([true]); // and the sender's own other views
    // A laser moved on the device that runs the talk reaches every other device too.
    room.peer.send({ type: "pointer", body: { x: 0.2, y: 0.2, visible: false } });
    expect(room.pointers).toEqual([true, false]);
    expect(overflow.pointers).toEqual([true, false]);
    expect(phone.pointers).toEqual([true, false]);
    t.wait(HEARTBEAT_MS);
    expect(phone.state()?.room?.audiences).toBe(2);
    // Keys on the second screen drive the talk through the first.
    overflow.peer.dispatch({ name: "next" });
    expect(room.page()).toBe(2);
  });

  it("when the host leaves, a follower carries the talk on at once", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const phone = t.join("Phone", B, "presenter");
    const laptop = t.join("Laptop", C, "presenter");
    phone.peer.send(next);
    phone.peer.send(next);
    room.peer.leave();
    room.connected = false;
    t.wait(1000);
    expect(t.hosts()).toHaveLength(1);
    expect(t.hosts()[0]).not.toBe("Room PC");
    expect(phone.page()).toBe(2);
    expect(laptop.page()).toBe(2);
    laptop.peer.send(next);
    expect(phone.page()).toBe(3);
    t.wait(HEARTBEAT_MS);
    expect(phone.state()?.room).toMatchObject({ audiences: 0 });
  });

  it("when the host vanishes without a word, a follower takes over after the timeout", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const phone = t.join("Phone", B, "presenter");
    phone.peer.send(next);
    room.connected = false; // crashed: no bye
    t.wait(HOST_TIMEOUT_MS - 1000);
    expect(phone.peer.hosting).toBe(false);
    t.wait(3000);
    expect(phone.peer.hosting).toBe(true);
    expect(phone.page()).toBe(1);
  });

  it("a slides screen that lost the network keeps going, and its state wins when it returns", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const phone = t.join("Phone", B, "presenter");
    room.drop();
    room.peer.dispatch({ name: "next" });
    room.peer.dispatch({ name: "next" });
    t.wait(HOST_TIMEOUT_MS + 2500); // the phone gives up on it and carries on alone, from page 0
    expect(t.hosts().sort()).toEqual(["Phone", "Room PC"]);
    expect(phone.page()).toBe(0);
    room.connect();
    t.wait(HEARTBEAT_MS);
    expect(t.hosts()).toEqual(["Room PC"]);
    expect(phone.page()).toBe(2);
    phone.peer.send(next);
    expect(room.page()).toBe(3);
  });

  it("of two presenter views that both host after a split, the one that just reconnected gives way", () => {
    const t = talk();
    const laptop = t.join("Laptop", A, "presenter");
    const phone = t.join("Phone", B, "presenter");
    laptop.drop();
    t.wait(HOST_TIMEOUT_MS + 2500);
    expect(phone.peer.hosting).toBe(true);
    phone.peer.send(next);
    phone.peer.send(next);
    laptop.connect(); // still thinks it hosts, at page 0
    t.wait(HEARTBEAT_MS);
    expect(t.hosts()).toEqual(["Phone"]);
    expect(laptop.page()).toBe(2);
  });

  it("a host that was asleep gives way to the device that carried the talk on", () => {
    const t = talk();
    const laptop = t.join("Laptop", A, "presenter");
    const phone = t.join("Phone", B, "presenter");
    // The laptop's tab is frozen: it stays connected but neither sends nor ticks.
    const frozen = laptop.peer.tick.bind(laptop.peer);
    laptop.peer.tick = () => {};
    laptop.connected = false;
    t.wait(HOST_TIMEOUT_MS + 2500);
    expect(phone.peer.hosting).toBe(true);
    phone.peer.send(next);
    // It wakes: still thinks it hosts, at page 0, with the older connection.
    laptop.peer.tick = frozen;
    laptop.connected = true;
    t.wait(HEARTBEAT_MS + 500);
    expect(t.hosts()).toEqual(["Phone"]);
    expect(laptop.page()).toBe(1);
  });

  it("a slides screen that goes back to choosing stays in the talk and keeps running it, but no longer counts as showing slides", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const phone = t.join("Phone", B, "presenter");
    phone.peer.send(next);
    room.peer.setView(null);
    expect(t.hosts()).toEqual(["Room PC"]);
    expect(phone.state()).toMatchObject({ page: 1, hostView: "presenter", room: { audiences: 0, devices: ["Room PC", "Phone"] } });
    phone.peer.send(next);
    expect(room.page()).toBe(2);
    room.peer.setView("audience");
    expect(phone.state()).toMatchObject({ page: 2, hostView: "audience", room: { audiences: 1 } });
  });

  it("End talk ends it on every device; leaving does not", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const phone = t.join("Phone", B, "presenter");
    const laptop = t.join("Laptop", C, "presenter");
    phone.peer.send({ type: "end", body: {} });
    expect([room.ended, phone.ended, laptop.ended]).toEqual([1, 1, 1]);
  });

  it("an old session's messages mean nothing to a new host", () => {
    const t = talk();
    const room = t.join("Room PC", A, "audience");
    const phone = t.join("Phone", B, "presenter");
    const old = phone.peer.session;
    room.peer.leave();
    room.connected = false;
    t.wait(1000);
    expect(phone.peer.hosting).toBe(true);
    expect(phone.peer.session).not.toBe(old);
    phone.peer.receive({ sid: C, seq: 1, to: old!, type: "command", body: { name: "next" } });
    expect(phone.page()).toBe(0);
  });

  it("a PDF opened from disk is a talk on this device alone, at once", () => {
    const t = talk();
    const solo = t.add("Laptop", A, { networked: false, connect: false });
    solo.peer.setView("presenter");
    expect(solo.peer.hosting).toBe(true);
    expect(solo.peer.send(next)).toBeGreaterThan(0);
    expect(solo.page()).toBe(1);
    expect(solo.state()?.timer.running).toBe(true); // the clock started with the first slide change
  });

  it("without a connection, a talk opened by code still starts here after a short wait", () => {
    const t = talk();
    const room = t.add("Room PC", A, { connect: false });
    room.peer.setView("audience");
    expect(room.peer.hosting).toBe(false);
    t.wait(2 * JOIN_WAIT_MS + 250);
    expect(room.peer.hosting).toBe(true);
  });
});
