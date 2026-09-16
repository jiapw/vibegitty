import { colorFor, initials } from "../lib/format";

export function Avatar({
  name,
  url,
  size,
  email,
}: {
  name: string;
  url?: string | null;
  size?: "small" | "large";
  email?: string;
}) {
  const key = email || name;
  return (
    <span className={`avatar${size ? " " + size : ""}`} style={{ background: colorFor(key) }} title={name}>
      {url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : initials(name)}
    </span>
  );
}
