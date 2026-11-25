import { Accordion, Alert, Box, Button, Group, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { api, type FollowedGame, type Game, type Group as LightGroup, type Me, type Settings } from "../api.ts";
import { testEffect } from "../effects.ts";
import { errorMessage, type Load } from "../load.ts";
import { Advanced } from "./Advanced.tsx";
import { GamePicker } from "./GamePicker.tsx";
import { Section } from "./Section.tsx";
import { TvSync } from "./TvSync.tsx";

const LEAGUE_KEY = "hls.league";

/** The league last browsed, remembered on this device only. */
function rememberedLeague(me: Me): string {
  try {
    const stored = localStorage.getItem(LEAGUE_KEY);
    if (stored && me.leagues.some((l) => l.id === stored)) return stored;
  } catch {
    // Storage can be blocked; the default does.
  }
  return me.leagues[0]?.id ?? "nfl";
}

const initialSettings = (me: Me): Settings => structuredClone(me.settings ?? { ...me.defaults, group: "" });

/** The signed-in screen: the game and the room up front, effects under Advanced. */
export function SettingsScreen({ me }: { me: Me }) {
  const [settings, setSettings] = useState<Settings>(() => initialSettings(me));
  const [saved, setSaved] = useState<string>(() => (me.settings ? JSON.stringify(me.settings) : ""));
  const [game, setGame] = useState<FollowedGame | undefined>(me.game);
  const [league, setLeague] = useState(() => me.game?.league ?? rememberedLeague(me));
  const [groups, setGroups] = useState<Load<LightGroup[]>>({ state: "loading" });
  /** "save", "test", "stop", or the key of the game being followed. */
  const [busy, setBusy] = useState<string | null>(null);

  const sport = me.leagues.find((l) => l.id === (game?.league ?? league))?.sport ?? "other";

  useEffect(() => {
    api
      .groups()
      .then((value) => {
        setGroups({ state: "ready", value });
        setSettings((s) => (value.some((g) => g.name === s.group) || !value[0] ? s : { ...s, group: value[0].name }));
      })
      .catch((err) => setGroups({ state: "error", message: errorMessage(err) }));
  }, []);

  const pickLeague = (id: string) => {
    setLeague(id);
    try {
      localStorage.setItem(LEAGUE_KEY, id);
    } catch {
      // Only a convenience.
    }
  };

  const dirty = JSON.stringify(settings) !== saved;

  /** The sync card saved a new delay on its own: take it in without making the rest look unsaved. */
  const delaySaved = (delaySeconds: number) => {
    setSettings((s) => ({ ...s, delaySeconds }));
    setSaved((json) => (json ? JSON.stringify({ ...(JSON.parse(json) as Settings), delaySeconds }) : json));
  };

  const save = async (quiet = false): Promise<boolean> => {
    if (!settings.group) {
      notifications.show({ color: "red", message: "Pick the room or zone to flash." });
      return false;
    }
    setBusy("save");
    try {
      const { settings: stored } = await api.save(settings);
      setSettings((s) => ({ ...s, effects: stored.effects }));
      setSaved(JSON.stringify(stored));
      if (!quiet) notifications.show({ color: "green", message: "Saved." });
      return true;
    } catch (err) {
      notifications.show({ color: "red", title: "Could not save", message: errorMessage(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const follow = async (picked: Game) => {
    if (dirty && !(await save(true))) return;
    setBusy(picked.key);
    try {
      const { game: followed } = await api.follow(picked);
      setGame(followed);
      notifications.show({
        color: "green",
        message: `Following ${followed.away.name} at ${followed.home.name}. ${settings.group} flashes for every score.`,
      });
    } catch (err) {
      notifications.show({ color: "red", title: "Could not follow that game", message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy("stop");
    try {
      await api.unfollow();
      setGame(undefined);
      notifications.show({ message: "Stopped following. Your lights stay as they are." });
    } catch (err) {
      notifications.show({ color: "red", title: "Could not stop", message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const effect = testEffect(sport, settings.effects);
    if (!effect) {
      notifications.show({ color: "red", message: "Turn on at least one effect first." });
      return;
    }
    if (dirty && !(await save(true))) return;
    setBusy("test");
    try {
      await api.test(effect);
      const colours = game ? ` in ${game.away.name} and ${game.home.name} colours` : "";
      notifications.show({ color: "green", message: `Flashed ${settings.group}${colours}.` });
    } catch (err) {
      notifications.show({ color: "red", title: "Could not flash", message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap="md">
      {/* `saved`, not `me.settings`: `me` is the page's first load and does not change when settings are saved. */}
      {!saved && (
        <Alert color="orange" variant="light" title="Almost there">
          Check the room to flash, then pick the game you're watching.
        </Alert>
      )}

      <Section
        title="Your game"
        description={
          game
            ? "Every score flashes, in the scoring team's colours, until the final whistle."
            : "Pick the game you're watching. Your lights follow it until the final whistle."
        }
      >
        <GamePicker
          leagues={me.leagues}
          league={league}
          onLeague={pickLeague}
          followed={game}
          busy={busy}
          onFollow={follow}
          onStop={stop}
        />
      </Section>

      <Section title="Your lights" description="The room or zone that flashes.">
        {groups.state === "error" ? (
          <Alert color="red">Could not reach your bridge through Hue: {groups.message}</Alert>
        ) : (
          <Select
            size="md"
            placeholder={groups.state === "loading" ? "Loading rooms…" : "Pick a room"}
            data={
              groups.state === "ready"
                ? groups.value.map((g) => ({ value: g.name, label: g.kind === "zone" ? `${g.name} (zone)` : g.name }))
                : []
            }
            value={settings.group || null}
            onChange={(v) => v && setSettings({ ...settings, group: v })}
            allowDeselect={false}
            aria-label="Room or zone"
          />
        )}
      </Section>

      <Section title="Sync with your TV" description="TV and streams run behind the game. Flashes wait for your TV, so they don't spoil the play.">
        <TvSync sport={sport} delaySeconds={settings.delaySeconds} following={Boolean(game)} onDelay={delaySaved} />
      </Section>

      <Accordion variant="separated" radius="lg">
        <Accordion.Item value="advanced">
          <Accordion.Control>
            <Text fw={600}>Advanced</Text>
            <Text c="dimmed" size="sm">
              The TV delay in seconds, effects and how the bridge flashes
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Advanced settings={settings} sport={sport} onChange={setSettings} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      {/* Sticky, not fixed: it floats while the settings scroll, then settles above the footer. */}
      <Box
        pos="sticky"
        bottom={0}
        py="md"
        style={{
          background: "linear-gradient(transparent, var(--mantine-color-body) 35%)",
          zIndex: 10,
        }}
      >
        <Group justify="space-between">
          <Button variant="default" size="md" onClick={test} loading={busy === "test"} disabled={busy !== null && busy !== "test"}>
            Test flash
          </Button>
          <Button size="md" onClick={() => save()} loading={busy === "save"} disabled={!dirty || (busy !== null && busy !== "save")}>
            {dirty ? "Save" : "Saved"}
          </Button>
        </Group>
      </Box>
    </Stack>
  );
}
