import { useState } from "react";
import { Search, X } from "lucide-react";
import { IconButton } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function SidebarSearch({
  onSearch,
  onClear,
}: {
  onSearch: (query: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <form
      className="search-box relative text-muted-foreground"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(query);
      }}
    >
      <Search />
      <Input
        className="pl-9 pr-9"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!event.target.value) onClear();
        }}
        aria-label="Search conversations"
        placeholder="Search"
      />
      <Button
        type="submit"
        className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap"
      >
        Search
      </Button>
      {query ? (
        <IconButton
          label="Clear search"
          onClick={() => {
            setQuery("");
            onClear();
          }}
        >
          <X />
        </IconButton>
      ) : null}
    </form>
  );
}
