import { useEffect, useState } from "react";
import { withTimeout } from "./companyFinance";

const IDLE = Object.freeze({ phase: "idle", data: null, error: null });

// Charge une ressource financière : délai maximal de 30 s, annulation au démontage, résultats tardifs ignorés.
export default function useFinanceLoader(load, deps) {
  const [state, setState] = useState(IDLE);
  useEffect(() => {
    if (!load) {
      setState(IDLE);
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setState({ phase: "loading", data: null, error: null });
    withTimeout((signal) => load(signal), { signal: controller.signal })
      .then((data) => {
        if (active) setState({ phase: "ready", data, error: null });
      })
      .catch((error) => {
        if (active && error?.name !== "AbortError") setState({ phase: "error", data: null, error });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
