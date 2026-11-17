import { memo, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { ipcErrorMessage, openExternalUrl } from "../../lib/ipc";
import { useT } from "../../lib/i18n";

export interface ElicitationRequest {
  runId: string;
  requestId: string;
  message: string;
  /** Raw elicitation/create detail: mode ("form"|"url"|other), requestedSchema, url, elicitationId. */
  detail: Record<string, unknown>;
}

export interface ElicitationModalProps {
  request: ElicitationRequest;
  onSubmit: (action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
}

/* One renderable schema property. Values live in a single record; numbers are
   kept as raw input strings and only converted to real numbers on accept. */
type FieldValue = string | boolean | string[];

interface PropField {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  kind: "string" | "enum" | "number" | "integer" | "boolean" | "array";
  /** enum members for "enum" and "array" kinds. */
  options?: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length > 0 ? out : null;
}

/* Returns the renderable fields for a form-mode request, or null when the
   detail is not a form with a usable requestedSchema (caller falls back to
   the unknown-mode body). */
function parseFields(detail: Record<string, unknown>): PropField[] | null {
  if (detail.mode !== "form") return null;
  if (!isPlainObject(detail.requestedSchema)) return null;
  const schema = detail.requestedSchema;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((v): v is string => typeof v === "string")
    : [];
  if (!isPlainObject(schema.properties)) return [];
  const fields: PropField[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    if (!isPlainObject(raw)) continue;
    const label = typeof raw.title === "string" && raw.title !== "" ? raw.title : name;
    const description = typeof raw.description === "string" ? raw.description : undefined;
    const requiredField = required.includes(name);
    const base = { name, label, description, required: requiredField };
    if (raw.type === "string") {
      const options = stringList(raw.enum);
      fields.push(options ? { ...base, kind: "enum", options } : { ...base, kind: "string" });
      continue;
    }
    if (raw.type === "number" || raw.type === "integer") {
      fields.push({ ...base, kind: raw.type });
      continue;
    }
    if (raw.type === "boolean") {
      fields.push({ ...base, kind: "boolean" });
      continue;
    }
    if (raw.type === "array" && isPlainObject(raw.items)) {
      const options = stringList(raw.items.enum);
      if (options) fields.push({ ...base, kind: "array", options });
      continue;
    }
    // Property type we cannot render honestly: skip it rather than guess.
  }
  return fields;
}

function initialValues(fields: PropField[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.kind === "boolean") out[field.name] = false;
    else if (field.kind === "array") out[field.name] = [];
    else out[field.name] = "";
  }
  return out;
}

function fieldFilled(field: PropField, value: FieldValue): boolean {
  if (!field.required) return true;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value.trim() === "") return false;
  if (field.kind === "number" || field.kind === "integer") return Number.isFinite(Number(value));
  return true;
}

function contentValue(field: PropField, value: FieldValue): unknown {
  if (field.kind === "boolean") return value === true;
  if (field.kind === "number" || field.kind === "integer") {
    // A blank optional number is omitted rather than sent as 0 or NaN.
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw === "") return undefined;
    const parsed = Number(raw);
    return field.kind === "integer" ? Math.trunc(parsed) : parsed;
  }
  return value;
}

const INPUT_CLASS =
  "w-full rounded-(--radius-sm) border border-border-strong bg-(--input) px-2 py-1.5 text-sm text-text-primary focus-visible:shadow-(--focus-ring) focus-visible:outline-none";

function RequiredMark({ required }: { required: boolean }) {
  if (!required) return null;
  return (
    <span aria-hidden="true" className="text-xs text-warning">
      *
    </span>
  );
}

export function ElicitationModal({
  request,
  onSubmit,
  inline = false,
}: ElicitationModalProps & { inline?: boolean }) {
  const t = useT();
  const { message, detail } = request;
  const fields = useMemo(() => parseFields(detail), [detail]);
  // Values are keyed to the request the modal mounts with; the parent mounts a
  // fresh modal per pending request, so no reset logic is needed here.
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    initialValues(fields ?? []),
  );
  const [urlError, setUrlError] = useState<string | null>(null);

  const url = typeof detail.url === "string" && detail.url !== "" ? detail.url : null;
  const isForm = fields !== null;
  const isUrl = detail.mode === "url" && url !== null;

  const setValue = (name: string, value: FieldValue) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const toggleOption = (name: string, option: string) =>
    setValues((prev) => {
      const current = prev[name];
      const list = Array.isArray(current) ? current : [];
      return {
        ...prev,
        [name]: list.includes(option) ? list.filter((o) => o !== option) : [...list, option],
      };
    });

  const canAccept = isForm && fields.every((field) => fieldFilled(field, values[field.name]));

  const accept = () => {
    if (!canAccept || fields === null) return;
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const value = contentValue(field, values[field.name]);
      if (value !== undefined) content[field.name] = value;
    }
    onSubmit("accept", content);
  };

  const openUrl = async () => {
    if (!url) return;
    setUrlError(null);
    try {
      await openExternalUrl(url);
      onSubmit("accept");
    } catch (err) {
      setUrlError(ipcErrorMessage(err));
    }
  };

  const card = (
    <div
      role="dialog"
      aria-modal={inline ? undefined : true}
      aria-label={message}
      className={
        inline
          ? "w-full overflow-hidden rounded-(--radius-md) border border-warning/40 bg-surface shadow-(--shadow-composer)"
          : "w-full max-w-lg overflow-hidden rounded-2xl border border-border-strong bg-(--surface-raised) shadow-(--shadow-composer)"
      }
    >
        <div className="bg-warning/10 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-warning">
          {t("chat.elicitation.request")}
        </div>
        <div className="space-y-4 px-4 py-3">
          <p className="text-sm text-text-primary">{message}</p>

          {isForm &&
            fields.map((field) => {
              const id = `elicitation-${field.name}`;
              const value = values[field.name];
              const help = field.description ? (
                <p className="text-xs text-text-tertiary">{field.description}</p>
              ) : null;
              if (field.kind === "boolean") {
                return (
                  <div key={field.name} className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <input
                        id={id}
                        type="checkbox"
                        className="size-3.5 accent-accent"
                        checked={value === true}
                        onChange={(e) => setValue(field.name, e.target.checked)}
                      />
                      <label htmlFor={id} className="text-xs text-text-secondary">
                        {field.label}
                      </label>
                      <RequiredMark required={field.required} />
                    </div>
                    {help}
                  </div>
                );
              }
              if (field.kind === "array") {
                const selected = Array.isArray(value) ? value : [];
                return (
                  <div key={field.name} className="space-y-1">
                    <div className="flex items-baseline gap-1">
                      <span className="text-xs text-text-secondary">{field.label}</span>
                      <RequiredMark required={field.required} />
                    </div>
                    <div
                      role="group"
                      aria-label={field.label}
                      className="flex flex-wrap gap-x-4 gap-y-1.5"
                    >
                      {(field.options ?? []).map((option) => (
                        <label
                          key={option}
                          className="flex items-center gap-1.5 text-xs text-text-secondary"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-accent"
                            checked={selected.includes(option)}
                            onChange={() => toggleOption(field.name, option)}
                          />
                          {option}
                        </label>
                      ))}
                    </div>
                    {help}
                  </div>
                );
              }
              return (
                <div key={field.name} className="space-y-1">
                  <div className="flex items-baseline gap-1">
                    <label htmlFor={id} className="text-xs text-text-secondary">
                      {field.label}
                    </label>
                    <RequiredMark required={field.required} />
                  </div>
                  {field.kind === "enum" ? (
                    <select
                      id={id}
                      className={INPUT_CLASS}
                      value={typeof value === "string" ? value : ""}
                      onChange={(e) => setValue(field.name, e.target.value)}
                    >
                      <option value="">{t("chat.elicitation.selectValue")}</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={id}
                      type={field.kind === "string" ? "text" : "number"}
                      step={field.kind === "integer" ? "1" : undefined}
                      className={INPUT_CLASS}
                      value={typeof value === "string" ? value : ""}
                      onChange={(e) => setValue(field.name, e.target.value)}
                    />
                  )}
                  {help}
                </div>
              );
            })}

          {isUrl && (
            <>
              <pre className="overflow-x-auto rounded-(--radius-sm) bg-code-bg p-2 font-mono text-xs break-all whitespace-pre-wrap text-text-secondary">
                {url}
              </pre>
              {urlError && (
                <p role="alert" className="text-xs text-danger">
                  {urlError}
                </p>
              )}
            </>
          )}

          {!isForm && !isUrl && (
            <p className="text-xs text-text-tertiary">{t("chat.elicitation.unknownMode")}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          {isForm && (
            <Button variant="primary" onClick={accept} disabled={!canAccept}>
              {t("chat.elicitation.accept")}
            </Button>
          )}
          {isUrl && (
            <Button variant="primary" onClick={() => void openUrl()}>
              {t("chat.elicitation.openUrl")}
            </Button>
          )}
          <Button variant="secondary" onClick={() => onSubmit("decline")}>
            {t("chat.elicitation.decline")}
          </Button>
          <Button variant="ghost" onClick={() => onSubmit("cancel")}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
  );
  if (inline) return <div className="mx-auto mb-2 w-full max-w-3xl">{card}</div>;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onSubmit("cancel");
      }}
    >
      {card}
    </div>
  );
}

export default memo(ElicitationModal);
