/** The settings most people never touch: the TV delay by number, how the bridge flashes, and each effect. */
import { Group, NumberInput, Radio, SegmentedControl, Stack, Switch, Text } from "@mantine/core";
import type { Effect, Settings } from "../api.ts";
import { effectKeysFor, LABELS } from "../effects.ts";

interface Props {
  settings: Settings;
  sport: string;
  onChange: (next: Settings) => void;
}

export function Advanced({ settings, sport, onChange }: Props) {
  const setEffect = (key: string, patch: Partial<Effect>) => {
    const current = settings.effects[key] ?? { enabled: false, seconds: 5, signal: "on_off_color" };
    onChange({ ...settings, effects: { ...settings.effects, [key]: { ...current, ...patch } } });
  };

  return (
    <Stack gap="xl">
      <NumberInput
        label="TV delay"
        description="How long flashes wait after each play. Syncing with your TV sets it for you."
        value={settings.delaySeconds}
        onChange={(v) => onChange({ ...settings, delaySeconds: Math.max(0, Math.min(600, Number(v) || 0)) })}
        min={0}
        max={600}
        step={1}
        decimalScale={1}
        suffix=" seconds"
        maw={220}
      />

      <Radio.Group
        label="How to flash"
        value={settings.effectMode}
        onChange={(v) => onChange({ ...settings, effectMode: v === "pulse" ? "pulse" : "signal" })}
      >
        <Stack gap="xs" mt="xs">
          <Radio value="signal" label="Bridge effect" description="The bridge runs the flash and puts your lights back. Best for most lights." />
          <Radio value="pulse" label="Manual pulse" description="For older lights that ignore the bridge effect." />
        </Stack>
      </Radio.Group>

      <div>
        <Text fw={500} size="sm">
          Effects
        </Text>
        <Text c="dimmed" size="xs" mb="xs">
          What flashes, for how long, and in one or both team colours.
        </Text>
        <Stack gap={0}>
          {effectKeysFor(sport).map((key, i) => {
            const fx = settings.effects[key] ?? { enabled: false, seconds: 5, signal: "on_off_color" as const };
            return (
              <Group
                key={key}
                justify="space-between"
                gap="xs"
                py="xs"
                style={i ? { borderTop: "1px solid var(--mantine-color-default-border)" } : undefined}
              >
                <Switch
                  checked={fx.enabled}
                  onChange={(e) => setEffect(key, { enabled: e.currentTarget.checked })}
                  label={LABELS[key] ?? key}
                />
                {fx.enabled && (
                  <Group gap="xs" wrap="nowrap">
                    <NumberInput
                      size="xs"
                      w={76}
                      value={fx.seconds}
                      onChange={(v) => setEffect(key, { seconds: Math.max(1, Math.min(30, Number(v) || 1)) })}
                      min={1}
                      max={30}
                      suffix=" s"
                      aria-label={`${LABELS[key]} seconds`}
                    />
                    <SegmentedControl
                      size="xs"
                      value={fx.signal}
                      onChange={(v) => setEffect(key, { signal: v === "alternating" ? "alternating" : "on_off_color" })}
                      data={[
                        { value: "on_off_color", label: "1 colour" },
                        { value: "alternating", label: "2 colours" },
                      ]}
                      aria-label={`${LABELS[key]} colours`}
                    />
                  </Group>
                )}
              </Group>
            );
          })}
        </Stack>
      </div>
    </Stack>
  );
}
