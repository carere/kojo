import { For } from "solid-js";
import { ToggleGroup, ToggleGroupItem } from "#components/ui/toggle-group";
import { m } from "../../../i18n/messages";
import { getLocale, locales, setLocale } from "../../../i18n/runtime";

type Locale = (typeof locales)[number];

const labels: Record<Locale, () => string> = {
  en: () => m.language_toggle_en(),
  fr: () => m.language_toggle_fr(),
};

export function LanguageToggle() {
  const current = getLocale();

  return (
    <ToggleGroup
      aria-label={m.language_toggle_label()}
      onChange={(next) => {
        if (next && next !== current) setLocale(next as Locale);
      }}
      size="sm"
      value={current}
      variant="outline"
    >
      <For each={locales}>
        {(locale) => (
          <ToggleGroupItem aria-label={labels[locale]()} value={locale}>
            {locale.toUpperCase()}
          </ToggleGroupItem>
        )}
      </For>
    </ToggleGroup>
  );
}
