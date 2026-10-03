import { Button } from "./components/ui/button";
import { Component, type ReactNode } from "react";

// Without a message, a failed load renders nothing because another boundary reports it.
export class AccountLoadBoundary extends Component<
  { children: ReactNode; onReload?: () => void; message?: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    if (!this.props.message) return null;
    return (
      <div role="alert">
        <p>{this.props.message}</p>
        <Button type="button" onClick={this.props.onReload}>
          Reload
        </Button>
      </div>
    );
  }
}
