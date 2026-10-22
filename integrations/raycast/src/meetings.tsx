import { Action, ActionPanel, Alert, confirmAlert, Detail, Form, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useState } from "react";
import { Assignment, Meeting } from "../../shared/client";
import { client, error, literal } from "./sirius";

function ApproveTasks({ meeting }: { meeting: Meeting }) {
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [dossiers, setDossiers] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    let alive = true;
    client().request<{ dossiers: { id: string; title: string }[] }>("/work-dossiers").then((result) => {
      if (alive) setDossiers(result.dossiers);
    }).catch(error);
    return () => { alive = false; };
  }, []);
  async function submit(values: Record<string, string>) {
    if (busy) return;
    const assignments: Assignment[] = (meeting.result?.tasks || []).flatMap((_, index) =>
      values[`task-${index}`] ? [{ task_index: index, participant_id: values[`task-${index}`] }] : []);
    if (!values.dossier || !assignments.length) {
      await error(new Error("Choisir un dossier et au moins une tâche avec son responsable."));
      return;
    }
    if (!await confirmAlert({ title: "Enregistrer les tâches choisies ?", message:
      "Responsables nominatifs dans votre dossier privé SIRIUS. Aucun message ni notification inter-compte.",
      primaryAction: { title: "Valider ces affectations", style: Alert.ActionStyle.Default } })) return;
    setBusy(true);
    try {
      await client().approve(meeting, values.dossier, assignments);
      await showToast({ style: Toast.Style.Success, title: "Tâches enregistrées dans le dossier privé" }); pop();
    } catch (failure) { await error(failure); }
    finally { setBusy(false); }
  }
  return <Form isLoading={busy} actions={<ActionPanel>
    <Action.SubmitForm title="Relire Et Valider" onSubmit={submit} />
  </ActionPanel>}>
    <Form.Description text="Chaque tâche est une proposition IA : vérifiez le fragment source et choisissez explicitement son responsable. Pas de correspondance automatique de nom vers un compte." />
    <Form.Dropdown id="dossier" title="Dossier privé">
      <Form.Dropdown.Item value="" title="Choisir un dossier" />
      {dossiers.map((item) => <Form.Dropdown.Item key={item.id} value={item.id} title={item.title} />)}
    </Form.Dropdown>
    {(meeting.result?.tasks || []).map((task, index) => <Form.Dropdown
      key={index} id={`task-${index}`} title={task.text}
      info={`Fragment ${task.evidence_sequence} : ${meeting.fragments?.[String(task.evidence_sequence)]?.text || "non disponible"}`}>
      <Form.Dropdown.Item value="" title="Ne pas créer cette tâche" />
      {meeting.participants.map((item) => <Form.Dropdown.Item key={item.id} value={item.id} title={`${item.label} (${item.id})`} />)}
    </Form.Dropdown>)}
  </Form>;
}

function MeetingDetail({ id }: { id: string }) {
  const [meeting, setMeeting] = useState<Meeting>();
  const refresh = () => client().detail(id).then(setMeeting).catch(error);
  useEffect(() => { void refresh(); }, [id]);
  const markdown = meeting ? `# ${literal(meeting.title)}\n\nÉtat : ${literal(meeting.state)}\n\n` +
    (meeting.capture_complete === false ? `**Capture incomplète** : ${literal(meeting.capture_reason || "interrompue")}\n\n` : "") +
    literal(meeting.result?.summary || meeting.error || "Synthèse non disponible.") +
    "\n\n## Propositions de tâches\n\n" + (meeting.result?.tasks || []).map((task, index) =>
      `${index + 1}. ${literal(task.text)} — fragment ${task.evidence_sequence}`).join("\n\n") +
    "\n\n## Transcription fournie (non vérifiée)\n\n" + Object.values(meeting.fragments || {})
      .sort((a, b) => a.sequence - b.sequence).map((fragment) =>
        `**${fragment.sequence} · ${fragment.speaker_id}** : ${literal(fragment.text)}`).join("\n\n") : "Chargement…";
  return <Detail isLoading={!meeting} markdown={markdown} actions={<ActionPanel>
    <Action title="Actualiser La Même Référence" onAction={refresh} />
    {meeting?.state === "READY" && !!meeting.result?.tasks.length &&
      <Action.Push title="Valider Les Tâches" target={<ApproveTasks meeting={meeting} />} />}
  </ActionPanel>} />;
}

export default function Command() {
  const [items, setItems] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try { setItems((await client().list()).items); } catch (failure) { await error(failure); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);
  return <List isLoading={loading} searchBarPlaceholder="Rechercher une réunion SIRIUS">
    <List.EmptyView title="Aucune réunion chargée" description="Vérifier l'URL API, la session et les droits du même compte."
      actions={<ActionPanel><Action title="Actualiser" onAction={refresh} /></ActionPanel>} />
    {items.map((item) => <List.Item key={item.id} title={item.title} subtitle={item.state}
      accessories={[{ text: item.created_at }]} actions={<ActionPanel>
        <Action.Push title="Consulter La Réunion" target={<MeetingDetail id={item.id} />} />
        <Action title="Actualiser" onAction={refresh} />
      </ActionPanel>} />)}
  </List>;
}
