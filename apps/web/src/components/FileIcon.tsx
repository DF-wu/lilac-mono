import { fileIconName } from "../file-icons";
import sprite from "../assets/file-icons/catppuccin.svg";
import "./file-icon.css";

export function FileIcon({ name, mediaType }: { name: string; mediaType?: string }) {
  const icon = fileIconName(name, mediaType);
  return (
    <svg
      className="file-icon"
      data-file-icon={icon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`${sprite}#${icon}`} />
    </svg>
  );
}
