import { randomUUID } from "node:crypto";
import { Action, ActionPanel, Detail, Form } from "@raycast/api";
import { useRef, useState } from "react";
import { client, error, literal } from "./sirius";

export default function Ask() {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const session = useRef(randomUUID());
  async function submit(values: { question: string }) {
    if (locked.current) return;
    if (!values.question.trim() || values.question.length > 4000) {
      await error(new Error("Question de 1 à 4 000 caractères requise.")); return;
    }
    locked.current = true; setBusy(true);
    try {
      const result = await client().ask(values.question.trim(), `raycast-${session.current}`);
      if (typeof result.answer !== "string" || !result.answer.trim()) throw new Error("Réponse SIRIUS vide ou non conforme.");
      setAnswer(result.answer);
    } catch (failure) { await error(failure); }
    finally { locked.current = false; setBusy(false); }
  }
  if (answer) return <Detail markdown={literal(answer)} actions={<ActionPanel>
    <Action title="Nouvelle Question" onAction={() => setAnswer("")} />
    <Action.CopyToClipboard title="Copier La Réponse" content={answer} />
  </ActionPanel>} />;
  return <Form isLoading={busy} actions={<ActionPanel><Action.SubmitForm title="Envoyer À Sirius" onSubmit={submit} /></ActionPanel>}>
    <Form.Description text="Votre texte sera transmis à votre service SIRIUS et aux fournisseurs IA configurés. Aucun contexte du presse-papiers, de l'écran ou des fichiers n'est collecté. Une coupure peut laisser une demande engagée : pas de nouvelle tentative automatique." />
    <Form.TextArea id="question" title="Question" placeholder="Que souhaitez-vous demander à SIRIUS ?" />
  </Form>;
}
