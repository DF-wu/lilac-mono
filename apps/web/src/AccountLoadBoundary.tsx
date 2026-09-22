import { Button } from "./components/ui/button";
import { Component, type ReactNode } from "react";

export class AccountLoadBoundary extends Component<
  { children: ReactNode; onReload: () => void; message: string },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
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
