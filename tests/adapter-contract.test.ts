import { describe, expect, it } from "vitest";
import { TurnChannel } from "../src/adapters/turn-channel.js";

describe("adapter turn channel", () => {
  it("streams ordered events and closes deterministically", async () => {
    const channel = new TurnChannel();
    channel.publish({ type: "MESSAGE_SUBMITTED", at: "1" });
    channel.publish({ type: "RESPONSE_STARTED", at: "2" });
    channel.finish();

    const received = [];
    for await (const event of channel.observe()) received.push(event.type);
    expect(received).toEqual(["MESSAGE_SUBMITTED", "RESPONSE_STARTED"]);
  });
});
