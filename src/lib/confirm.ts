import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  message?: string;
  ok?: string;
  danger?: boolean;
  resolve: (yes: boolean) => void;
}

export const useConfirm = create<{ req: ConfirmRequest | null }>(() => ({ req: null }));

export function ask(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = useConfirm.getState().req;
    if (prev) prev.resolve(false);
    useConfirm.setState({ req: { ...opts, resolve } });
  });
}

export function answerConfirm(yes: boolean): void {
  const req = useConfirm.getState().req;
  if (!req) return;
  useConfirm.setState({ req: null });
  req.resolve(yes);
}
