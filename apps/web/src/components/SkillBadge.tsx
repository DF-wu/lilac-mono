import { useContext, type ReactNode } from "react";
import { Package } from "lucide-react";
import { inlineChipStyles } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SkillCatalogContext } from "./skill-mentions";

export function SkillBadge({ name, children }: { name: string; children?: ReactNode }) {
  const skills = useContext(SkillCatalogContext);
  const description = skills.find((skill) => skill.name === name)?.description;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-ui="skill-badge"
            className={`[&>svg]:size-[1em] [&>svg]:shrink-0 ${inlineChipStyles}`}
          />
        }
      >
        <Package aria-hidden="true" />
        <span className="overflow-hidden text-ellipsis">{name}</span>
        {children}
      </TooltipTrigger>
      <TooltipContent>{description || name}</TooltipContent>
    </Tooltip>
  );
}
