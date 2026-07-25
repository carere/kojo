import { Monitor, Moon, Sun } from "lucide-solid";
import { For } from "solid-js";
import { ToggleGroup, ToggleGroupItem } from "#components/ui/toggle-group";
import { m } from "../../../i18n/messages";
import { type ColorMode, useColorMode } from "../services/color-mode";

export function ThemeToggle() {
  const { colorMode, setColorMode } = useColorMode();
  const options = () => [
    { value: "light" as const, label: m.theme_toggle_light(), Icon: Sun },
    { value: "dark" as const, label: m.theme_toggle_dark(), Icon: Moon },
    { value: "system" as const, label: m.theme_toggle_system(), Icon: Monitor },
  ];

  return (
    <ToggleGroup
      aria-label={m.theme_toggle_label()}
      onChange={(next) => {
        if (next) setColorMode(next as ColorMode);
      }}
      size="sm"
      value={colorMode()}
      variant="outline"
    >
      <For each={options()}>
        {(option) => (
          <ToggleGroupItem aria-label={option.label} value={option.value}>
            <option.Icon />
          </ToggleGroupItem>
        )}
      </For>
    </ToggleGroup>
  );
}
