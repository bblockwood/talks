// The room PC's end of the relay (SPEC §8). Created when a deck is opened by code, so the entry
// screen can say whether a phone can connect; handed to the presentation when Start is clicked.
import type { TalkKeys } from "../core/crypto";
import { APP_VERSION } from "../core/protocol";
import type { Envelope, Message } from "../core/protocol";
import { RelayClient, deviceName } from "../shared/relay-client";
import type { LinkStatus } from "../shared/relay-client";

export class RoomLink {
  /** Set by the presentation while a talk is running. */
  onMessage: ((envelope: Envelope) => void) | null = null;
  onStatus: ((status: string) => void) | null = null;
  status: LinkStatus = "connecting";
  private readonly client: RelayClient;

  constructor(keys: TalkKeys) {
    this.client = new RelayClient({
      roomId: keys.roomId,
      channelKey: keys.channelKey,
      role: "room",
      onMessage: (envelope) => this.handle(envelope),
      onStatus: (status) => {
        this.status = status;
        this.onStatus?.(status);
      },
    });
  }

  send(message: Message): void {
    this.client.send(message);
  }

  close(): void {
    this.onMessage = null;
    this.onStatus = null;
    this.client.close();
  }

  private handle(envelope: Envelope): void {
    if (this.onMessage) {
      this.onMessage(envelope);
      return;
    }
    // Not presenting yet: let a phone see that the room PC is here and waiting for Start.
    if (envelope.type === "hello" && envelope.body.role !== "room") {
      this.send({ type: "hello", body: { role: "room", device: deviceName(), appVersion: APP_VERSION } });
    } else if (envelope.type === "ping") {
      this.send({ type: "pong", body: { t: envelope.body.t } });
    }
  }
}
