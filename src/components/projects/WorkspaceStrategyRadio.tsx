/** App-styled radio for the project workspace strategy. */
export function WorkspaceStrategyRadio({
  name,
  label,
  description,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-(--radius-sm) px-2 py-1.5 transition hover:bg-hover">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border-strong transition peer-checked:border-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40"
      >
        <span
          className={`h-2 w-2 rounded-full bg-accent transition ${
            checked ? "opacity-100" : "opacity-0"
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-text-secondary">{label}</span>
        {description && <span className="block text-xs text-text-tertiary">{description}</span>}
      </span>
    </label>
  );
}
