import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { clockReply, failWith } from "../stories/fakeApi.ts";
import { Section } from "./Section.tsx";
import { TvSync } from "./TvSync.tsx";

/** The card as the settings screen shows it, keeping the delay it sets. */
function Card(props: Omit<Parameters<typeof TvSync>[0], "onDelay">) {
  const [delaySeconds, setDelay] = useState(props.delaySeconds);
  return (
    <Section title="Sync with your TV" description="TV and streams run behind the game. Flashes wait for your TV, so they don't spoil the play.">
      <TvSync {...props} delaySeconds={delaySeconds} onDelay={setDelay} />
    </Section>
  );
}

const meta = {
  title: "Components/TvSync",
  component: Card,
  args: { sport: "football", delaySeconds: 20, following: true },
  decorators: [(Story) => <div style={{ maxWidth: 480 }}>{Story()}</div>],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Following a live game with the clock running: the TV's clock ticks, 20 s behind the feed. */
export const ClockRunning: Story = {};

/** A timeout: the clock holds, on the TV too. */
export const ClockStopped: Story = { parameters: { api: { "GET /api/clock": clockReply({ running: false }) } } };

/** Basketball's last minute shows tenths, as the broadcast does. */
export const LastMinute: Story = {
  args: { sport: "basketball", delaySeconds: 16 },
  parameters: { api: { "GET /api/clock": clockReply({ delaySeconds: 16, live: 31, period: 4 }) } },
};

/** Before the feeds have sent a clock, only the nudges are there. */
export const NoClockYet: Story = { parameters: { api: { "GET /api/clock": { at: 0, delaySeconds: 20 } } } };

/** Baseball has no clock at all. */
export const Baseball: Story = {
  args: { sport: "baseball" },
  parameters: { api: { "GET /api/clock": { at: 0, delaySeconds: 20 } } },
};

export const NotFollowing: Story = { args: { following: false } };

/** Pick "Sync", then tap as the TV shows the time asked for: the delay is set from that tap. */
export const Sync: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sync with my TV" }));
    await userEvent.click(await canvas.findByRole("button", { name: /Tap when your TV shows Q3 \d:\d\d/ }));
    await expect(await within(document.body).findByText("Synced. Flashes now wait 23.4 s for your TV.")).toBeInTheDocument();
    await expect(canvas.getByText("Waiting 23.4 s for your TV")).toBeInTheDocument();
  },
};

/** Flashes came early: one more second of waiting. */
export const NudgeLater: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Flashes early" }));
    await expect(await canvas.findByText("Waiting 21 s for your TV")).toBeInTheDocument();
  },
};

/** Over the air or in the stadium: the TV is ahead of every feed, so nothing can wait for it. */
export const TvAhead: Story = {
  parameters: { api: { "POST /api/sync": { delaySeconds: 0, ahead: true } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sync with my TV" }));
    await userEvent.click(await canvas.findByRole("button", { name: /Tap when your TV shows/ }));
    await expect(await within(document.body).findByText(/Your TV is ahead of our scores/)).toBeInTheDocument();
  },
};

/** The server could not place the time tapped on (the clock moved on to a new period, say). */
export const SyncRefused: Story = {
  parameters: {
    api: { "POST /api/sync": failWith(422, "Can't line up with that time yet. Try again once the game clock is running.") },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sync with my TV" }));
    await userEvent.click(await canvas.findByRole("button", { name: /Tap when your TV shows/ }));
    await expect(await within(document.body).findByText("Could not sync")).toBeInTheDocument();
  },
};
