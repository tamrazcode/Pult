/** File drop bridge: the chat surface emits, the mounted composer attaches. */
export const ATTACHMENT_DROP_EVENT = "pult:attach-files";

export function emitAttachmentDrop(files: FileList | File[] | null): void {
  const list = files ? Array.from(files) : [];
  if (list.length === 0) return;
  window.dispatchEvent(new CustomEvent<File[]>(ATTACHMENT_DROP_EVENT, { detail: list }));
}
