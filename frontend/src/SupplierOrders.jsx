import { useCallback, useEffect, useRef, useState } from "react";
import { downloadText } from "./companyFinance";
import { orderAmount, orderDecimal, supplierCart, supplierOrdersRequest as api } from "./supplierOrdersApi";
import "./SupplierOrders.css";

const TEST_NOTICE = "Mode essai : les commandes sont enregistrées, mais aucun e-mail n’est envoyé.";
const DEFAULT_PORTAL_NAME = "Portail de commandes";
const emptySupplier = { name: "", email: "", price_basis: "HT" };
const emptyProduct = () => ({ reference: "", name: "", unit: "", price: "" });
const productFields = { reference: "Référence", name: "Produit", unit: "Unité", price: "Prix unitaire" };

function SupplierFields({ value, onChange }) {
  return <>
    <label>Nom du fournisseur<input required maxLength={160} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} /></label>
    <label>E-mail du fournisseur (à compléter)<input type="email" maxLength={254} value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} /></label>
    <label>Base des prix<select value={value.price_basis} onChange={(e) => onChange({ ...value, price_basis: e.target.value })}><option>HT</option><option>TTC</option></select></label>
  </>;
}

function SupplierEditor({ supplier, request, run, onSaved, onCancel }) {
  const [info, setInfo] = useState({ name: supplier.name, email: supplier.email, price_basis: supplier.price_basis });
  const [products, setProducts] = useState(() => supplier.products.map(({ id, ...row }) => row));
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const normalized = products.map((row) => ({ ...row, price: orderDecimal(row.price) }));
      await request(`/suppliers/${supplier.id}/catalog`, {
        method: "PUT", body: { version: supplier.version, supplier: info, products: normalized },
      });
      await onSaved();
    });
  };
  const importCsv = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    run(async () => {
      if (file.size > 500000) throw new Error("CSV trop volumineux (500 Ko maximum).");
      const preview = await request(`/suppliers/${supplier.id}/catalog/preview`, {
        method: "POST", body: { csv: await file.text() },
      });
      setProducts(preview.products);
    });
  };
  return <form className="b2b-editor" onSubmit={save} aria-label={`Grille ${supplier.name}`}>
    <div className="b2b-fields"><SupplierFields value={info} onChange={setInfo} /></div>
    <p>Les prix sont en euros, jusqu’à quatre décimales. Précisez l’unité vendue (kg, litre, carton…). TVA et livraison non calculées.</p>
    <div className="b2b-actions">
      <button type="button" onClick={() => run(async () => {
        if (!downloadText("modele-grille-fournisseur.csv", "\ufeffreference;nom;unite;prix\r\n")) throw new Error("Téléchargement indisponible.");
      })}>Modèle CSV</button>
      <label>Charger un CSV<input type="file" accept=".csv,text/csv" onChange={importCsv} /></label>
    </div>
    <p>Le CSV remplace les lignes affichées, sans les enregistrer. Vérifiez la grille avant de sauvegarder. Colonnes : reference;nom;unite;prix.</p>
    <div className="b2b-product-edit">
      {products.map((row, index) => <fieldset key={index}>
        <legend>Produit {index + 1}</legend>
        {Object.entries(productFields).map(([key, label]) => <label key={key}>{label}
          <input required maxLength={key === "unit" ? 30 : 160} inputMode={key === "price" ? "decimal" : undefined}
            value={row[key]} onChange={(e) => setProducts((current) => current.map((item, at) => at === index ? { ...item, [key]: e.target.value } : item))} />
        </label>)}
        <button type="button" onClick={() => setProducts((current) => current.filter((_row, at) => at !== index))}>Retirer la ligne {index + 1}</button>
      </fieldset>)}
    </div>
    <div className="b2b-actions">
      <button type="button" disabled={products.length >= 500} onClick={() => setProducts((current) => [...current, emptyProduct()])}>Ajouter un produit</button>
      <button className="b2b-primary" type="submit">Enregistrer le fournisseur et sa grille ({products.length})</button>
      <button type="button" onClick={onCancel}>Annuler les modifications</button>
    </div>
    <p>Enregistrer remplace la grille de ce fournisseur. Les anciennes commandes conservent leurs prix.</p>
  </form>;
}

function OrderSummary({ order, onPreview }) {
  return <div className="b2b-receipt">
    <p><strong>{order.client_name}</strong> · {order.contact}</p>
    <p className="b2b-multiline">Livraison : {order.delivery_address}</p>
    {order.note && <p className="b2b-multiline">Note : {order.note}</p>}
    {order.supplier_orders.map((part) => <section key={part.supplier_id} className="b2b-card">
      <h3>{part.supplier_name}</h3>
      <ul>{part.lines.map((line) => <li key={line.id}>
        {line.reference} — {line.name} : {line.quantity.replace(".", ",")} {line.unit} × {orderAmount(line.price)} = {orderAmount(line.total)} {part.price_basis}
      </li>)}</ul>
      <strong>Total : {orderAmount(part.total)} {part.price_basis}</strong>
      <p>Non envoyé — commande d’essai.</p>
      {onPreview && <button type="button" onClick={() => onPreview(part)}>Prévisualiser le message pour {part.supplier_name}</button>}
    </section>)}
    <p>TVA et frais de livraison non calculés. Aucun paiement demandé.</p>
  </div>;
}

export default function SupplierOrdersManager({ embedded = false, managerToken = "" }) {
  const [data, setData] = useState(null);
  const [portalName, setPortalName] = useState("");
  const [supplier, setSupplier] = useState(emptySupplier);
  const [customer, setCustomer] = useState({ name: "", email: "" });
  const [managerName, setManagerName] = useState("Commercial");
  const [editing, setEditing] = useState("");
  const [link, setLink] = useState("");
  const [managerLink, setManagerLink] = useState(null);
  const [revoke, setRevoke] = useState("");
  const [revokeManager, setRevokeManager] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const request = useCallback((path, options = {}) => api(path, { ...options, managerToken }), [managerToken]);
  const load = useCallback(async (signal) => {
    const result = await request("", { signal });
    if (!["suppliers", "clients", "orders"].every((key) => Array.isArray(result[key]))) throw new Error("Réponse de gestion invalide.");
    setData(result);
    setPortalName(result.portal_name || DEFAULT_PORTAL_NAME);
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => { if (cause.name !== "AbortError") setError(cause.message); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (managerToken && data?.portal_name) document.title = data.portal_name;
  }, [managerToken, data?.portal_name]);
  const run = async (action) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { setError(cause.message || "Action impossible."); }
    finally { pending.current = false; setBusy(false); }
  };
  const addSupplier = (e) => {
    e.preventDefault();
    run(async () => {
      const row = await request("/suppliers", { method: "POST", body: supplier });
      setSupplier(emptySupplier); await load(); setEditing(row.id);
    });
  };
  const addClient = (e) => {
    e.preventDefault();
    run(async () => {
      const created = await request("/clients", { method: "POST", body: customer });
      setLink(created.url); setCustomer({ name: "", email: "" }); await load();
    });
  };
  const addManager = (e) => {
    e.preventDefault();
    run(async () => {
      const created = await request("/manager-links", { method: "POST", body: { name: managerName } });
      setManagerLink(created); await load();
    });
  };
  return <section className={`b2b ${embedded ? "b2b-embedded" : "b2b-page"}`} aria-label="Gestion des commandes fournisseurs">
    <header className="b2b-header">
      <div><p className="b2b-eyebrow">{managerToken ? "ESPACE COMMERCIAL" : "ΣIRIUS · ESPACE COMMERCIAL"}</p><h1>{managerToken ? (data?.portal_name || DEFAULT_PORTAL_NAME) : "Commandes multi-fournisseurs"}</h1></div>
      {embedded && <a href="https://sirius-assistant.fr/commandes/gestion" target="_blank" rel="noreferrer">Ouvrir la gestion sur le web</a>}
    </header>
    <p className="b2b-notice">{TEST_NOTICE}</p>
    {error && <p role="alert" className="b2b-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!data && !error && <p role="status">Chargement du portail…</p>}
    <fieldset className="b2b-controls" disabled={busy}>
      <button type="button" onClick={() => run(() => load())}>Actualiser la gestion</button>
      {data && <>
        <section className="b2b-card">
          <h2>Nom du portail</h2>
          <p>Ce nom sera visible par le commercial et ses clients. Il peut être choisi ou modifié ensemble plus tard.</p>
          <form className="b2b-fields" onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await request("/settings", { method: "PUT", body: { name: portalName } });
              await load(); setNotice("Nom du portail enregistré.");
            });
          }}>
            <label>Nom du portail<input required maxLength={160} value={portalName} onChange={(e) => setPortalName(e.target.value)} /></label>
            <button type="submit">Enregistrer le nom</button>
          </form>
        </section>
        {managerToken ? <p className="b2b-notice">Les fournisseurs, clients et commandes sont partagés avec le titulaire du compte qui a créé ce lien. Il peut aussi les consulter et les modifier.</p> :
          <section className="b2b-card">
            <h2>Accès privé du commercial</h2>
            <p>Ce lien donne accès aux mêmes fournisseurs, clients et commandes que ce module. Transmettez-le seulement au commercial, avec son accord. Toute personne possédant le lien pourra gérer ces données.</p>
            <form className="b2b-fields" onSubmit={addManager}>
              <label>Nom de l’accès commercial<input required maxLength={160} value={managerName} onChange={(e) => setManagerName(e.target.value)} /></label>
              <button type="submit">Créer le lien commercial</button>
            </form>
            {managerLink && <div className="b2b-link">
              <label>Lien commercial privé à conserver (affiché une seule fois)<input readOnly value={managerLink.url} onFocus={(e) => e.target.select()} /></label>
              <button type="button" onClick={() => run(async () => {
                if (!navigator.clipboard?.writeText) throw new Error("Copie automatique indisponible : sélectionnez et copiez le lien ci-dessus.");
                await navigator.clipboard.writeText(managerLink.url); setNotice("Lien commercial copié.");
              })}>Copier le lien commercial</button>
              <a href={managerLink.url} target="_blank" rel="noreferrer">Ouvrir l’espace du commercial</a>
            </div>}
            <ul>{(data.manager_links || []).map((row) => <li key={row.id}>{row.name} — {row.active ? "Actif" : "Révoqué"}{" "}
              {row.active && <button type="button" onClick={() => setRevokeManager(row.id)}>Révoquer l’accès commercial de {row.name}</button>}
              {revokeManager === row.id && <div><p>Ce lien ne fonctionnera plus. Les fournisseurs, clients et commandes seront conservés.</p>
                <button type="button" onClick={() => run(async () => {
                  await request(`/manager-links/${row.id}`, { method: "DELETE" });
                  if (managerLink?.link.id === row.id) setManagerLink(null);
                  setRevokeManager(""); await load();
                })}>Confirmer la révocation commerciale</button><button type="button" onClick={() => setRevokeManager("")}>Annuler</button></div>}
            </li>)}</ul>
            {data.manager_links_truncated && <p>Seuls les 100 premiers accès commerciaux sont affichés.</p>}
          </section>}
        <section className="b2b-card">
          <h2>1. Fournisseurs et grilles</h2>
          {!data.suppliers.length && <p>Ajoutez vos fournisseurs maintenant. Les grilles pourront être complétées ou importées plus tard.</p>}
          <form onSubmit={addSupplier} className="b2b-fields">
            <SupplierFields value={supplier} onChange={setSupplier} />
            <button type="submit">Ajouter le fournisseur</button>
          </form>
          {data.suppliers.map((row) => <article className="b2b-supplier" key={row.id}>
            <div className="b2b-header"><strong>{row.name}</strong><span>{row.products.length} produit(s) · EUR {row.price_basis}</span>
              <button type="button" onClick={() => setEditing(row.id)}>Configurer {row.name}</button></div>
            {!row.email && <p>E-mail fournisseur à renseigner avant les futurs envois réels.</p>}
            {editing === row.id && <SupplierEditor key={`${row.id}-${row.version}`} supplier={row} request={request} run={run}
              onSaved={async () => { await load(); setEditing(""); setNotice("Grille enregistrée pour le portail."); }} onCancel={() => setEditing("")} />}
          </article>)}
        </section>
        <section className="b2b-card">
          <h2>2. Accès clients privés</h2>
          <p>Chaque lien donne accès à toutes les grilles de cet espace. Ne le partagez qu’avec le client concerné. Les clients n’ont pas accès à la gestion ni aux commandes des autres.</p>
          <form onSubmit={addClient} className="b2b-fields">
            <label>Nom du client ou de son établissement<input required maxLength={160} value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} /></label>
            <label>E-mail du client (facultatif)<input type="email" maxLength={254} value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} /></label>
            <button type="submit">Créer un lien client</button>
          </form>
          {link && <div className="b2b-link">
            <label>Lien privé à conserver (affiché une seule fois)<input readOnly value={link} onFocus={(e) => e.target.select()} /></label>
            <button type="button" onClick={() => run(async () => {
              if (!navigator.clipboard?.writeText) throw new Error("Copie automatique indisponible : sélectionnez et copiez le lien ci-dessus.");
              await navigator.clipboard.writeText(link); setNotice("Lien copié.");
            })}>Copier le lien</button>
            <a href={link} target="_blank" rel="noreferrer">Ouvrir le portail d’essai</a>
          </div>}
          <ul>{data.clients.map((row) => <li key={row.id}>{row.name} — {row.active ? "Actif" : "Révoqué"}{" "}
            {row.active && <button type="button" onClick={() => setRevoke(row.id)}>Révoquer l’accès de {row.name}</button>}
            {revoke === row.id && <div><p>Le lien de ce client cessera de fonctionner. Les commandes déjà enregistrées seront conservées.</p>
              <button type="button" onClick={() => run(async () => {
                await request(`/clients/${row.id}/link`, { method: "DELETE" }); setRevoke(""); await load();
              })}>Confirmer la révocation</button><button type="button" onClick={() => setRevoke("")}>Annuler</button></div>}
          </li>)}</ul>
          {data.clients_truncated && <p>Seuls les 1 000 premiers accès sont affichés.</p>}
        </section>
        <section className="b2b-card">
          <h2>3. Commandes réparties par fournisseur</h2>
          {!data.orders.length && <p>Aucune commande d’essai enregistrée.</p>}
          {data.orders_truncated && <p>Les 100 commandes les plus récentes sont affichées.</p>}
          {data.orders.map((order) => <details key={order.id}>
            <summary>{order.client_name} · {new Date(order.created_at).toLocaleString("fr-FR")} · Essai non envoyé</summary>
            <p>Référence : {order.id}</p>
            <OrderSummary order={order} onPreview={(part) => run(async () => {
              const preview = await request(`/orders/${order.id}/suppliers/${part.supplier_id}/message`);
              if (!downloadText(preview.filename, preview.content, "message/rfc822")) throw new Error("Téléchargement du message indisponible.");
              setNotice("Message d’essai téléchargé, non envoyé. Il ne contient que les produits de ce fournisseur.");
            })} />
          </details>)}
        </section>
      </>}
    </fieldset>
  </section>;
}

export function FriendSupplierManager() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("k") || "";
  if (!token) return <main className="b2b b2b-page">
    <h1>{DEFAULT_PORTAL_NAME}</h1>
    <p className="b2b-notice">Ouvrez le lien commercial privé qui vous a été transmis pour accéder à votre gestion.</p>
  </main>;
  return <SupplierOrdersManager key={token} managerToken={token} />;
}

export function SupplierOrderPortal() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("k") || "";
  return <ClientPortal key={token} token={token} />;
}

function ClientPortal({ token }) {
  const [catalog, setCatalog] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [supplierFilter, setSupplierFilter] = useState("");
  const [search, setSearch] = useState("");
  const [contact, setContact] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [pendingOrder, setPendingOrder] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const sending = useRef(false);
  const load = useCallback(async (signal) => {
    if (!token) throw new Error("Ouvrez le lien privé transmis par votre commercial.");
    const result = await api("/catalog", { token, signal });
    if (!Array.isArray(result.suppliers) || !result.client_id || !result.version) throw new Error("Catalogue reçu invalide.");
    const key = `sirius_b2b_pending_${result.client_id}`;
    const stored = sessionStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (!parsed.request_id || !Array.isArray(parsed.lines) || !parsed.catalog_version) throw new Error("Reprise de commande illisible. Contactez votre commercial avant de recommander.");
      setPendingOrder(parsed);
    }
    sessionStorage.setItem(`${key}_check`, "1"); sessionStorage.removeItem(`${key}_check`);
    setStorageReady(true); setCatalog(result);
  }, [token]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((cause) => { if (cause.name !== "AbortError") setError(cause.message); });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (catalog?.portal_name) document.title = catalog.portal_name;
  }, [catalog?.portal_name]);
  let groups = [], cartError = "";
  try { groups = supplierCart(catalog?.suppliers || [], quantities); }
  catch (cause) { cartError = cause.message; }
  const submit = async (e) => {
    e.preventDefault();
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    const key = `sirius_b2b_pending_${catalog.client_id}`;
    try {
      const body = pendingOrder || {
        request_id: crypto.randomUUID(), catalog_version: catalog.version,
        contact, delivery_address: address, note,
        lines: groups.flatMap((group) => group.lines.map((line) => ({
          supplier_id: group.id, product_id: line.id, quantity: line.quantity,
        }))),
      };
      sessionStorage.setItem(key, JSON.stringify(body));
      setPendingOrder(body);
      const saved = await api("/orders", { method: "POST", token, body });
      setReceipt(saved);
      try { sessionStorage.removeItem(key); setPendingOrder(null); }
      catch {
        setStorageReady(false);
        setError("Commande enregistrée, mais le stockage de reprise ne peut pas être effacé. Ne repassez pas commande : conservez la référence ci-dessous et contactez votre commercial.");
      }
    } catch (cause) {
      if ([400, 409, 422].includes(cause.status)) {
        try { sessionStorage.removeItem(key); setPendingOrder(null); setReloadRequired(true); }
        catch {
          setStorageReady(false);
          setError(`${cause.message} Le stockage de reprise ne peut pas être effacé. Contactez votre commercial avant de recommander.`);
          return;
        }
      }
      setError(cause.message || "Réponse non reçue. Réessayez la même validation pour éviter un doublon.");
    } finally { sending.current = false; setBusy(false); }
  };
  const locked = busy || !!pendingOrder;
  return <main className="b2b b2b-page" aria-label="Portail de commande client">
    <header className="b2b-header"><div><p className="b2b-eyebrow">{catalog?.portal_name || DEFAULT_PORTAL_NAME}</p><h1>Votre commande, plusieurs fournisseurs</h1></div></header>
    <p className="b2b-notice">{TEST_NOTICE}</p>
    {error && <p className="b2b-error" role="alert">{error}</p>}
    {!catalog && !error && <p role="status">Chargement des grilles…</p>}
    {!catalog && error && token && <button type="button" onClick={() => { setError(""); load().catch((cause) => setError(cause.message)); }}>Réessayer le chargement</button>}
    {catalog && <>
      <p>Bienvenue, <strong>{catalog.client_name}</strong>. Les produits sont regroupés par fournisseur. Une seule validation prépare une commande séparée pour chacun.</p>
      {receipt ? <section role="status">
        <h2>Commande d’essai enregistrée — aucun e-mail envoyé</h2><p>Référence : {receipt.id}</p>
        <OrderSummary order={receipt} />
        <button type="button" disabled={busy || !!pendingOrder} onClick={() => { setReceipt(null); setQuantities({}); setNote(""); }}>Nouvelle commande d’essai</button>
      </section> : <>
        {pendingOrder && <section className="b2b-notice">
          <h2>Validation à reprendre</h2>
          <p>Une validation attend sa confirmation. Ne créez pas de nouvelle commande : le bouton ci-dessous reprend exactement la même demande, sans doublon.</p>
          <p>Contact : {pendingOrder.contact} · {pendingOrder.lines.length} produit(s)</p>
          <form onSubmit={submit}><button disabled={busy} className="b2b-primary">Réessayer la même validation</button></form>
        </section>}
        {!catalog.suppliers.length && <section className="b2b-card"><h2>Les grilles arrivent bientôt</h2><p>Votre commercial n’a pas encore ajouté de produits. Revenez une fois ses grilles renseignées.</p></section>}
        <fieldset className="b2b-controls" disabled={locked}>
          <div className="b2b-fields">
            <label>Fournisseur<select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option value="">Tous les fournisseurs</option>
              {catalog.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select></label>
            <label>Rechercher un produit<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          </div>
          {catalog.suppliers.filter((supplier) => !supplierFilter || supplier.id === supplierFilter).map((supplier) => <section className="b2b-card" key={supplier.id}>
            <h2>{supplier.name} <small>Prix EUR {supplier.price_basis}</small></h2>
            {supplier.products.filter((row) => `${row.name} ${row.reference}`.toLocaleLowerCase("fr").includes(search.toLocaleLowerCase("fr"))).map((product) => <article className="b2b-product" key={product.id}>
              <div><strong>{product.name}</strong><p>Réf. {product.reference} · {orderAmount(product.price)} {supplier.price_basis} / {product.unit}</p></div>
              <label>Quantité ({product.unit})<input aria-label={`Quantité ${product.name} (${supplier.name})`} inputMode="decimal" maxLength={20}
                value={quantities[product.id] || ""} onChange={(e) => setQuantities({ ...quantities, [product.id]: e.target.value })} /></label>
            </article>)}
          </section>)}
          <section className="b2b-card">
            <h2>Votre panier</h2>
            {cartError && <p role="alert" className="b2b-error">{cartError}</p>}
            {!groups.length && !cartError && <p>Indiquez les quantités souhaitées dans les grilles ci-dessus.</p>}
            {groups.map((group) => <section key={group.id}>
              <h3>{group.name}</h3>
              <ul>{group.lines.map((line) => <li key={line.id}>{line.name} — {line.quantity.replace(".", ",")} {line.unit} : {orderAmount(line.total)} {group.price_basis}{" "}
                <button type="button" onClick={() => setQuantities({ ...quantities, [line.id]: "" })}>Retirer {line.name}</button></li>)}</ul>
              <strong>Total {group.name} : {orderAmount(group.total)} {group.price_basis}</strong>
            </section>)}
            <p>TVA et frais de livraison non calculés. Les totaux HT et TTC de fournisseurs différents ne sont pas mélangés.</p>
            <form onSubmit={submit} className="b2b-checkout">
              <label>Votre nom ou contact<input required maxLength={160} value={contact} onChange={(e) => setContact(e.target.value)} /></label>
              <label>Adresse de livraison<input required maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} /></label>
              <label>Note commune à tous les fournisseurs (facultatif)<textarea maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <button className="b2b-primary" disabled={!storageReady || !groups.length || !!cartError || reloadRequired}>Valider la commande d’essai</button>
            </form>
          </section>
          <button type="button" onClick={async () => {
            setBusy(true); setError("");
            try { await load(); setQuantities({}); setReloadRequired(false); }
            catch (cause) { setError(cause.message); }
            finally { setBusy(false); }
          }}>Recharger les tarifs et vider le panier</button>
        </fieldset>
      </>}
    </>}
  </main>;
}
