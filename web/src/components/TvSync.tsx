/**
 * Lines the flashes up with the viewer's TV: one tap when the TV's game clock
 * shows a given time, then early/late nudges. The server keeps the game's
 * clock; this card only shows it and reports the tap.
 */
import { Button, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { api, type ClockReading, type ClockState, type League } from "../api.ts";
import { advance, clockText, targetAfter } from "../clock.ts";
import { errorMessage } from "../load.ts";

/** The clock is fetched again this often while the card is on screen. */
const POLL_MS = 5_000;
const TICK_MS = 100;

interface Props {
  sport: League["sport"];
  delaySeconds: number;
  /** A game is followed. Sync needs its clock. */
  following: boolean;
  onDelay: (delaySeconds: number) => void;
}

type Target = Pick<ClockReading, "period" | "seconds">;

const seconds = (s: number) => `${Number.isInteger(s) ? s : s.toFixed(1)} s`;

export function TvSync({ sport, delaySeconds, following, onDelay }: Props) {
  /** The last clock answer, and when (client time) it stood. */
  const [clock, setClock] = useState<{ state: ClockState; at: number } | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [target, setTarget] = useState<Target | undefined>();
  const [busy, setBusy] = useState<"sync" | "nudge" | null>(null);

  useEffect(() => {
    if (!following) {
      setClock(undefined);
      return;
    }
    let live = true;
    const load = async () => {
      const sent = Date.now();
      try {
        const state = await api.clock();
        // The readings stood when the server answered: about halfway through the round trip.
        if (live) setClock({ state, at: (sent + Date.now()) / 2 });
      } catch {
        // Shown as "no clock yet"; the next poll tries again.
      }
    };
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [following, delaySeconds]);

  const ticking = Boolean(clock?.state.tv?.running || clock?.state.live?.running);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  const project = (r: ClockReading | undefined) => (r && clock ? advance(r, now - clock.at, sport) : undefined);
  const tv = project(clock?.state.tv);
  const live = project(clock?.state.live);

  const startSync = (from: ClockReading | undefined) => {
    const next = from && targetAfter(from, sport);
    if (!next) {
      notifications.show({ message: "Wait for the game clock to run, then try again." });
      return;
    }
    setTarget(next);
  };

  const tap = async () => {
    if (!target) return;
    setBusy("sync");
    try {
      const { delaySeconds: synced, ahead } = await api.sync(target);
      onDelay(synced);
      setTarget(undefined);
      notifications.show({
        color: "green",
        message: ahead
          ? "Your TV is ahead of our scores, so flashes come as soon as we hear."
          : `Synced. Flashes now wait ${seconds(synced)} for your TV.`,
      });
    } catch (err) {
      notifications.show({ color: "red", title: "Could not sync", message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const nudge = async (by: number) => {
    setBusy("nudge");
    try {
      const { delaySeconds: next } = await api.setDelay(Math.max(0, Math.round((delaySeconds + by) * 10) / 10));
      onDelay(next);
    } catch (err) {
      notifications.show({ color: "red", title: "Could not change the delay", message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const nudges = (
    <Group gap="xs" wrap="nowrap">
      <Text size="sm" c="dimmed" style={{ flex: 1 }}>
        Waiting {seconds(delaySeconds)} for your TV
      </Text>
      <Button variant="default" size="xs" onClick={() => nudge(1)} disabled={busy !== null}>
        Flashes early
      </Button>
      <Button variant="default" size="xs" onClick={() => nudge(-1)} disabled={busy !== null || delaySeconds <= 0}>
        Flashes late
      </Button>
    </Group>
  );

  if (!following) {
    return (
      <Text size="sm" c="dimmed">
        Once you follow a game, sync the lights with the clock on your TV here. Waiting {seconds(delaySeconds)} for now.
      </Text>
    );
  }

  if (sport === "baseball" || !tv) {
    return (
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {sport === "baseball"
            ? "Baseball has no clock to sync with. If flashes come early or late, nudge them."
            : "When the game clock is running, you can sync the lights with the clock on your TV."}
        </Text>
        {nudges}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" c="dimmed">
          Your TV should be showing
        </Text>
        <Text fw={700} size="xl" ff="monospace" aria-live="off" data-testid="tv-clock">
          {clockText(sport, tv)}
        </Text>
      </div>
      {target ? (
        <Stack gap={6}>
          <Button size="lg" onClick={tap} loading={busy === "sync"}>
            Tap when your TV shows {clockText(sport, target)}
          </Button>
          <Group gap="xs" justify="space-between">
            <Button variant="subtle" size="xs" onClick={() => startSync(live)} disabled={busy !== null}>
              My TV is already past that
            </Button>
            <Button variant="subtle" size="xs" color="gray" onClick={() => setTarget(undefined)} disabled={busy !== null}>
              Cancel
            </Button>
          </Group>
        </Stack>
      ) : (
        <Button variant="light" onClick={() => startSync(tv)} disabled={busy !== null}>
          Sync with my TV
        </Button>
      )}
      {nudges}
    </Stack>
  );
}
