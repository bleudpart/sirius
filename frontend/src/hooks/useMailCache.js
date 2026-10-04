import { useCallback, useEffect, useRef, useState } from "react";
import { clearMailCache, enableMailCache, MAIL_CACHE_EVENT, MAIL_CACHE_PROVIDERS, mailCacheAccount, readMailCache, syncMailCache } from "../services/mailCache";

export default function useMailCache(user) {
  const account = mailCacheAccount(user);
  const [state, setState] = useState({ account: "", providers: {}, errors: {}, busy: {} });
  const jobs = useRef({});
  const currentAccount = useRef(account);
  currentAccount.current = account;

  const reload = useCallback(() => {
    if (!account) { setState({ account, providers: {}, errors: {}, busy: {} }); return; }
    const providers = {};
    const errors = {};
    for (const provider of Object.keys(MAIL_CACHE_PROVIDERS)) {
      try { providers[provider] = readMailCache(account, provider); }
      catch (error) { console.error("Lecture du cache mail impossible :", error); errors[provider] = error.message; }
    }
    setState((previous) => ({ account, providers, errors: { ...(previous.account === account ? previous.errors : {}), ...errors }, busy: previous.account === account ? previous.busy : {} }));
  }, [account]);

  const run = useCallback(async (provider, activate = false) => {
    if (!account || jobs.current[provider]) return;
    const controller = new AbortController();
    jobs.current[provider] = controller;
    setState((previous) => ({ ...previous, busy: { ...previous.busy, [provider]: true }, errors: { ...previous.errors, [provider]: "" } }));
    try {
      if (activate) await enableMailCache(account, provider, controller.signal);
      await syncMailCache(account, provider, controller.signal);
      reload();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Synchronisation du cache mail impossible :", error);
      if (currentAccount.current === account) {
        setState((previous) => ({ ...previous, errors: { ...previous.errors, [provider]: error.message } }));
      }
    } finally {
      if (jobs.current[provider] === controller) {
        delete jobs.current[provider];
        if (currentAccount.current === account) setState((previous) => ({ ...previous, busy: { ...previous.busy, [provider]: false } }));
      }
    }
  }, [account, reload]);

  const clear = useCallback((provider) => {
    jobs.current[provider]?.abort();
    delete jobs.current[provider];
    try {
      clearMailCache(account, provider);
      setState((previous) => ({ ...previous, errors: { ...previous.errors, [provider]: "" }, busy: { ...previous.busy, [provider]: false } }));
      reload();
      return true;
    } catch (error) {
      console.error("Effacement du cache mail impossible :", error);
      setState((previous) => ({ ...previous, errors: { ...previous.errors, [provider]: error.message }, busy: { ...previous.busy, [provider]: false } }));
      return false;
    }
  }, [account, reload]);

  useEffect(() => {
    reload();
    const changed = (event) => { if (event.detail?.account === account) reload(); };
    const storage = () => reload();
    window.addEventListener(MAIL_CACHE_EVENT, changed);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(MAIL_CACHE_EVENT, changed);
      window.removeEventListener("storage", storage);
      Object.values(jobs.current).forEach((controller) => controller.abort());
      jobs.current = {};
    };
  }, [account, reload]);

  useEffect(() => {
    if (!account) return undefined;
    const sync = () => {
      if (document.hidden || navigator.onLine === false) return;
      for (const provider of Object.keys(MAIL_CACHE_PROVIDERS)) {
        try { if (readMailCache(account, provider).enabled) void run(provider); }
        catch (error) {
          console.error("Synchronisation automatique du cache mail impossible :", error);
          setState((previous) => ({ ...previous, errors: { ...previous.errors, [provider]: error.message } }));
        }
      }
    };
    sync();
    const timer = setInterval(sync, 5 * 60 * 1000);
    window.addEventListener("online", sync);
    return () => { clearInterval(timer); window.removeEventListener("online", sync); };
  }, [account, run]);

  return { ...(state.account === account ? state : { providers: {}, errors: {}, busy: {} }), account, run, clear };
}
