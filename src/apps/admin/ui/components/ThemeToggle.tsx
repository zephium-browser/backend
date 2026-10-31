import { type Theme, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

const OPTIONS: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "system" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <fieldset class="theme-toggle">
      <legend class="sr-only">Colour theme</legend>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          class="theme-option"
          aria-pressed={theme === option.value}
          title={option.label}
          onClick={() => setTheme(option.value)}
        >
          <Icon name={option.icon} />
          <span class="sr-only">{option.label}</span>
        </button>
      ))}
    </fieldset>
  );
}
