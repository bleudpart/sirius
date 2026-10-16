"""Deterministic financial commands; data and confirmation never inferred by an LLM."""

import re
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from ariane_market_runs import MarketRunIn
from finance_workspace import AlertAction, DisableAction, PreviewIn, RoutineAction
from work_conversation import normalized

ALIASES = {"apple": "AAPL", "microsoft": "MSFT", "nvidia": "NVDA", "tesla": "TSLA"}
FINANCE_WORDS = r"\b(?:portus|nummarius|portefeuille|financieres?|boursiere?s?|boursier|aapl|msft|nvda|tsla)\b"


def is_finance_command(text):
    value = normalized(text)
    named_asset = re.search(r"\b(?:apple|microsoft|nvidia|tesla)\b", value) and re.search(
        r"\b(?:analys\w*|compare|cours|action|bourse|alerte|surveille|previens|avertis|pourquoi|achete|vends|vaut|prix|dettes?|benefices?|dividendes?|resultats|rentable|capitalisation|fondamentaux)\b", value)
    referenced_asset = re.search(r"\b(?:compare|pourquoi|cours)\b.*\b(?:cette action|ces (?:trois )?actions)\b", value)
    return bool(re.fullmatch(r"(?:confirme finance|suivi financier|reprends analyse) [a-f0-9]{32}[.!? ]*", value)
                or ((re.search(FINANCE_WORDS, value) or named_asset or referenced_asset)
                    and not re.search(r"\b(?:ouvre|ouvrir|ferme|fermer)\b", value)))


def format_number(value):
    return "indisponible" if value is None else f"{value:.2f}"


class FinanceConversation:
    def __init__(self, service):
        self.service = service

    async def handle(self, req, user):
        text = normalized(req.text)
        if not is_finance_command(text):
            return None
        uid = user["user_id"]
        match = re.fullmatch(r"(confirme finance|suivi financier|reprends analyse) ([a-f0-9]{32})[.!? ]*", text)
        if match:
            if match[1] == "confirme finance":
                result = await self.service.confirm(uid, match[2])
                return {"state": result["state"], "executed": True,
                        "answer": "Modification financière confirmée et enregistrée. Aucun ordre de bourse transmis.",
                        "finance_result": result}
            result = await (self.service.runs.execute(uid, match[2]) if match[1] == "reprends analyse"
                            else self.service.runs.status(uid, match[2]))
            return self.run_answer(result)
        if re.search(r"\b(?:achete|acheter|vends|vendre|ordre|envoie|envoyer|vend)\b", text):
            return self.clarify("Aucun passage d'ordre ni envoi financier n'est disponible. Je peux analyser ou préparer une surveillance.")
        if "portefeuille" in text:
            if re.search(r"\b(?:ajoute|importe|modifie|supprime|efface|remplace)\b", text):
                return self.clarify("Ouvrez PORTUS → Portefeuille : saisissez les lignes ou importez le CSV, vérifiez l'aperçu puis confirmez le remplacement. Aucune position n'a été modifiée.")
            result = await self.service.valuation(uid)
            lines = ["Faits : positions déclarées par vous, cours de clôture différés.",
                     "| Action | Quantité | Valeur USD | Gain latent USD | Poids % |",
                     "|---|---:|---:|---:|---:|"]
            for item in result["positions"]:
                lines.append(f"| {item['symbol']} | {item['quantity']} | {format_number(item['value'])} | "
                             f"{format_number(item['unrealized_pnl'])} | {format_number(item['weight_pct'])} |")
                if item["source"]:
                    lines.append(f"Source {item['symbol']} : {item['source']['source']}, séance {item['source']['as_of']}, "
                                 f"reçu {item['source']['fetched_at']}, version {item['source']['data_version']}.")
                    if item["source"]["age_calendar_days"] > 7:
                        lines.append("Attention : historique ancien, pas un cours actuel.")
            lines += [f"Calculs : total {format_number(result['total_value'])} USD ; volatilité théorique "
                      f"{format_number(result['volatility_pct'])} % ; baisse maximale théorique "
                      f"{format_number(result['max_drawdown_pct'])} %."]
            if result["state"] == "EMPTY":
                lines.append("Aucune position déclarée. Je ne peux pas déduire votre portefeuille de la liste de suivi.")
            if result["missing"]:
                lines.append("Lecture incomplète : " + ", ".join(result["missing"]) + ". Aucun total global annoncé.")
            concentrated = [p["symbol"] for p in result["positions"] if (p["weight_pct"] or 0) > 35]
            lines.append("Interprétation : " + ("concentration supérieure à 35 % sur " + ", ".join(concentrated)
                                              if concentrated else "aucun constat de concentration exploitable, pas une absence de risque."))
            lines.extend(result["limitations"])
            return {"state": "READ_ONLY", "executed": False, "answer": "\n".join(lines)}
        if re.search(r"\b(?:mes|liste|montre|affiche)\b.*\b(?:alertes|routines|surveillances)\b", text):
            overview = await self.service.overview(uid)
            lines = ["Surveillances et routines financières enregistrées (notifications dans PORTUS, sans push extérieur)."]
            for kind in ("alerts", "routines"):
                for item in overview[kind]["items"]:
                    lines.append(f"- {item['id']} : {item.get('symbol') or ', '.join(item.get('symbols', []))}"
                                 f" · {'suspendu' if item['disabled'] else 'actif'} · {item.get('condition') or item['recurrence']}.")
                if overview[kind]["truncated"]:
                    lines.append("Liste partielle : cent dernières configurations.")
            for item in overview["notifications"][:10]:
                lines.append(f"- {item['created_at']} : {item['text']}")
            return {"state": "READ_ONLY", "executed": False, "answer": "\n".join(lines)}
        disable = re.search(r"\b(?:suspends|suspendre|desactive)\b.*\b(alerte|routine)\b.*\b([a-f0-9]{32})\b", text)
        if disable:
            return await self.preview(uid, DisableAction(target_kind="alert" if disable[1] == "alerte" else "routine",
                                                        target_id=disable[2]))
        if re.search(r"\b(?:supprime|efface|annule|modifie|desactive|suspends)\b", text):
            return self.clarify("Pour suspendre une alerte ou routine, donnez sa référence exacte dans PORTUS. "
                                "La suspension doit ensuite être confirmée ; aucune modification effectuée.")
        symbols = []
        for word in re.findall(r"\b[a-z0-9]+\b", text):
            symbol = ALIASES.get(word, word.upper())
            if symbol in ("AAPL", "MSFT", "NVDA", "TSLA") and symbol not in symbols:
                symbols.append(symbol)
        if not symbols:
            return self.clarify("Précisez les actions : AAPL (Apple), MSFT (Microsoft), NVDA (Nvidia) ou TSLA (Tesla). "
                                "Je n'associe pas « cette action » à une position sans référence explicite.")
        period = "5y" if re.search(r"\b(?:5|cinq) ans\b", text) else "1m" if "mois" in text else "3m" if "trimestre" in text else "1y"
        if re.search(r"\b(?:chaque|tous les|routine|programme|planifie)\b", text):
            hour = re.search(r"\ba (\d{1,2})(?:[h:]([0-5]\d))?(?:\s*h(?:eures?)?)?\b", text)
            recurrence = "weekly" if re.search(r"\b(?:vendredis?|lundis?|mardis?|mercredis?|jeudis?|samedis?|dimanches?)\b", text) else "daily"
            if recurrence == "daily" and not re.search(r"\b(?:chaque (?:matin|jour)|tous les (?:matins|jours))\b", text):
                return self.clarify("Précisez « chaque matin » ou un jour de la semaine. Aucun calendrier implicite ne sera créé.")
            if not hour or int(hour[1]) > 23:
                return self.clarify("Précisez l'heure, par exemple « Chaque matin à 9 h analyse AAPL et MSFT ». "
                                    "La récurrence sera un intervalle UTC fixe, affiché avant confirmation.")
            zone_name = (req.environment or {}).get("timezone") or "Europe/Paris"
            if not isinstance(zone_name, str):
                raise HTTPException(422, "Fuseau horaire de conversation invalide.")
            try:
                zone = ZoneInfo(zone_name)
            except (ValueError, ZoneInfoNotFoundError) as exc:
                raise HTTPException(422, "Fuseau horaire de conversation invalide.") from exc
            now = datetime.now(timezone.utc)
            local = now.astimezone(zone)
            start = local.replace(hour=int(hour[1]), minute=int(hour[2] or 0), second=0, microsecond=0)
            if recurrence == "weekly":
                weekdays = {"lundi": 0, "mardi": 1, "mercredi": 2, "jeudi": 3, "vendredi": 4, "samedi": 5, "dimanche": 6}
                day = next((n for word, n in weekdays.items() if word in text), None)
                if day is None:
                    return self.clarify("Précisez le jour de la routine hebdomadaire.")
                start += timedelta(days=(day - start.weekday()) % 7)
            if start.astimezone(timezone.utc) <= now:
                start += timedelta(days=7 if recurrence == "weekly" else 1)
            roundtrip = start.astimezone(timezone.utc).astimezone(zone)
            if roundtrip.replace(tzinfo=None) != start.replace(tzinfo=None) or (
                start.replace(fold=0).utcoffset() != start.replace(fold=1).utcoffset()
            ):
                return self.clarify("Cette heure est ambiguë ou inexistante au changement d'heure. Choisissez une autre heure.")
            return await self.preview(uid, RoutineAction(symbols=symbols, period=period, start_at=start,
                                                        recurrence=recurrence))
        if re.search(r"\b(?:alerte|alerte-moi|previens|avertis|surveille)\b", text):
            if len(symbols) != 1:
                return self.clarify("Préparez une surveillance à la fois, avec un seul symbole.")
            if re.search(r"\bmm\s*200\b", text) or (re.search(r"\b(?:200|deux cents)\b", text) and re.search(r"\bmoyenne\b", text)):
                if not re.search(r"\b(?:dessus|dessous|hausse|baisse)\b", text):
                    return self.clarify("Précisez franchissement de la MM200 à la hausse ou à la baisse.")
                condition = "cross_below_mm200" if re.search(r"\b(?:dessous|baisse)\b", text) else "cross_above_mm200"
                action = AlertAction(symbol=symbols[0], condition=condition)
            else:
                threshold = re.search(r"(?:au-dessus de|au-dessous de|dessous de|dessus de|depasse|sous)\s+(\d+(?:[.,]\d+)?)", text)
                if not threshold:
                    return self.clarify("Précisez le seuil : « Alerte-moi si AAPL dépasse 200 dollars » ou « Surveille AAPL sous 150 dollars ».")
                if re.search(r"\b(?:eur|euros?)\b", text):
                    return self.clarify("Les seuils de ce catalogue sont en USD, pas en euros.")
                condition = "price_below" if re.search(r"\b(?:dessous|sous)\b", text) else "variation_above" if "%" in text or "pour cent" in text else "price_above"
                value = float(threshold[1].replace(",", "."))
                if not 0 < value <= 1e9:
                    return self.clarify("Le seuil doit être strictement positif et inférieur ou égal à un milliard.")
                action = AlertAction(symbol=symbols[0], condition=condition, threshold=value)
            return await self.preview(uid, action)
        if re.search(r"\b(?:pourquoi|actualites?|resultats|dividendes?|rentable|dettes?|benefices?|capitalisation|fondamentaux)\b", text):
            return self.clarify("Les actualités, comptes et motifs d'une baisse ne sont pas raccordés. "
                                "Je peux décrire le cours et les indicateurs, pas inventer une cause.")
        return self.run_answer(await self.service.runs.create(uid, MarketRunIn(
            request_id=uuid.uuid4(), symbols=symbols, period=period,
        )))

    async def preview(self, uid, action):
        result = await self.service.preview(uid, PreviewIn(request_id=uuid.uuid4(), action=action))
        return {"state": "WAITING_CONFIRMATION", "executed": False, "finance_preview": result,
                "answer": result["summary"] + f"\nAucune modification exécutée. Pour valider exactement cet aperçu, dites "
                          f"« Confirme finance {result['id']} ». Un oui seul n'autorise rien. Aperçu valable trente minutes."}

    @staticmethod
    def clarify(answer):
        return {"state": "NEEDS_CLARIFICATION", "executed": False, "answer": answer}

    @staticmethod
    def run_answer(result):
        lines = [f"ARIANE : {result['id']} · {result['state']}.",
                 "Faits : clôtures différées ; calculs déterministes PORTUS, pas des prévisions.",
                 "| Action | Clôture | MM200 | RSI14 | Volatilité % |", "|---|---:|---:|---:|---:|"]
        for step in result["steps"]:
            if not step["id"].startswith("analysis:"):
                continue
            output = step["output"]
            if not output:
                lines.append(f"{step['id']} : {step['state']}.")
                continue
            latest = output["latest"]
            lines.append(f"| {output['symbol']} | {format_number(latest['close'])} {output['currency']} | "
                         f"{format_number(latest['mm200'])} | {format_number(latest['rsi14'])} | "
                         f"{format_number(output['volatility_20d_annualized_pct'])} |")
            lines.append(f"Source {output['symbol']} : {output['source']}, séance {output['as_of']}, "
                         f"reçu {output['fetched_at']}. Calcul {output['calculation_version']}, données {output['data_version']}.")
            if step["snapshot_age_calendar_days"] > 7:
                lines.append("Attention : source vieille de plus de sept jours, pas un cours actuel.")
        summary = next((step["output"] for step in result["steps"] if step["id"] == "summary"), None)
        lines.append("Interprétation : " + (summary["text"] if summary else "bilan incomplet, aucune réussite globale annoncée."))
        lines.append("Graphiques et preuves détaillées : PORTUS / ARIANE, suivi de cette référence. Aucun ordre ni alerte créé.")
        return {"state": result["state"], "executed": False, "answer": "\n".join(lines),
                "finance_run_id": result["id"]}
