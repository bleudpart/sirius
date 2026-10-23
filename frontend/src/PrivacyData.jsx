import { BACKEND_BASE_URL } from "./lib/api";
import { loadVoiceConfig } from "./voice";

export default function PrivacyData({ onOpenAccount, onMemory, onConnections }) {
  const voice = loadVoiceConfig();
  return <section className="setup-section setup-single" data-testid="setup-panel-confidentialite">
    <h2>Confidentialité et données</h2>
    <p>ΣIRIUS n'est pas entièrement hors ligne. « Local » peut désigner cet appareil ou le serveur connecté : ce ne sont pas nécessairement la même machine.</p>
    <dl>
      <dt><strong>Sur cet appareil</strong></dt>
      <dd>Préférences d'interface et anciennes listes manuelles des modules de travail. Elles ne sont pas automatiquement synchronisées entre appareils.
        Les préparations prédictives ARIANE, facultatives, gardent seulement les types de modèles, jours et heures sur 28 jours.
        Désactivation, effacement et export sont dans ARIANE ; l'export serveur ne contient pas ces habitudes de l'appareil.</dd>
      <dt><strong>Dans le service connecté</strong></dt>
      <dd>Dossiers unifiés, parcours, rappels et mémoire du service. L'hébergement dépend de votre installation.
        Service utilisé : <code>{BACKEND_BASE_URL}</code>. Même compte et même service sont nécessaires pour retrouver ces données ailleurs.</dd>
      <dt><strong>Chez des fournisseurs extérieurs</strong></dt>
      <dd>Une demande IA, une transcription distante ou une recherche web peut transmettre le contenu nécessaire au fournisseur configuré.
        Les missions de micro-outils ARIANE transmettent l'objectif, les données et les exemples fournis à Cerebras après votre confirmation.
        Cerebras, Groq, Kimi et les autres services ne sont pas tous appelés à chaque demande. Leur présence dans les réglages ne prouve pas leur utilisation pour une réponse donnée.</dd>
      <dt><strong>Lecture vocale choisie</strong></dt>
      <dd>{voice.name?.startsWith("browser") ? "Voix de l'appareil sélectionnée." : "Voix distante sélectionnée : le texte à lire peut être transmis à Google ou Gemini selon l'appareil."}
        {" "}Les voix et possibilités hors ligne dépendent du système. La transcription du microphone est distincte de la lecture vocale.</dd>
      <dt><strong>Courriels et calendriers</strong></dt>
      <dd>Les comptes connectés donnent accès aux données selon les autorisations accordées. Une recherche Microsoft transmet ses mots-clés à Microsoft. Déconnecter un compte n'efface pas les données déjà enregistrées dans un dossier.</dd>
      <dt><strong>Téléphone Vapi, facultatif</strong></dt>
      <dd>Les appels réels transmettent l'audio, l'objectif et la conversation à Vapi et aux fournisseurs vocaux/IA configurés.
        Les sortants nécessitent votre confirmation ARIANE, les entrants une autorisation distincte.
        SIRIUS ne conserve ni audio ni transcription téléphonique, mais garde les numéros sortants, références,
        états, coûts rapportés et paramètres des parcours jusqu'à leur effacement.
        L'export et la suppression du compte couvrent ces données serveur, pas les données conservées chez Vapi.
        Désactiver les entrants ou arrêter un parcours ne raccroche pas un appel déjà en cours.</dd>
      <dt><strong>Raycast et réunions Discord/Slack, facultatifs</strong></dt>
      <dd>Raycast envoie seulement vos questions explicites et consulte les réunions du compte connecté.
        Le bot Discord demande l'accord individuel des participants avant toute réception audio.
        Les fragments audio sont transmis au moteur STT SIRIUS configuré, les transcriptions à Cerebras pour synthèse.
        SIRIUS conserve texte, participants, accords déclarés et propositions ; aucun fichier audio n'est sauvegardé par le bot.
        Les tâches doivent être validées et affectées nominativement dans un dossier privé, sans notification inter-compte.
        Slack reçoit uniquement la synthèse et les tâches validées après confirmation de publication ; aucun audio de Huddle n'est capturé.
        L'effacement d'une réunion ne supprime pas ses tâches déjà enregistrées ni les publications Slack ou les données des fournisseurs.</dd>
      <dt><strong>Automatisations Zapier, facultatives</strong></dt>
      <dd>Une clé dédiée, limitée et révocable autorise les Zaps que vous configurez.
        Les déclencheurs transmettent à Zapier les titres des nouveaux dossiers ou les synthèses des nouvelles réunions,
        jamais les fragments audio ni les transcriptions complètes. Les étapes suivantes de votre Zap peuvent partager ces données ailleurs.
        L'ajout de notes est automatique dans le dossier privé choisi, sans appel IA ni validation de tâches.
        Révoquer la clé arrête les prochains envois, mais ne rappelle pas une requête déjà partie.
        L'effacement du compte ne supprime pas les données déjà reçues par Zapier ou ses destinations.</dd>
      <dt><strong>WhatsApp et synchronisation Google Workspace, facultatifs</strong></dt>
      <dd>La liaison WhatsApp demande un code à envoyer depuis votre numéro à la ligne professionnelle configurée.
        Meta transmet les textes reçus à la boîte SIRIUS du compte lié ; les expéditeurs non liés sont ignorés.
        Aucun message entrant ne déclenche d'action ni de réponse automatique.
        Google fournit un instantané limité de votre boîte Gmail et des événements à venir, pas une sauvegarde complète.
        Les notifications de changement ne contiennent pas le corps des e-mails ; SIRIUS relit les métadonnées autorisées.
        Les nouveaux envois WhatsApp/Gmail et événements de cette intégration nécessitent un aperçu et une confirmation dans SIRIUS.
        Déconnecter arrête les prochains traitements, mais ne rappelle pas un envoi déjà engagé et n'efface pas les copies chez Meta ou Google.</dd>
      <dt><strong>Conservation et suppression</strong></dt>
      <dd>Il n'existe pas ici de durée unique garantie pour tous les modules. Les fournisseurs appliquent leurs propres conditions.
        L'effacement du compte ne supprime pas automatiquement vos fichiers exportés, sauvegardes ou toutes les listes présentes sur un autre appareil.</dd>
    </dl>
    <h3>Agir sur mes données</h3>
    {onMemory && <button type="button" className="setup-io-btn" onClick={onMemory}>Examiner ma mémoire</button>}
    {onConnections && <button type="button" className="setup-io-btn" onClick={onConnections}>Gérer les comptes connectés</button>}
    {onOpenAccount ? <button type="button" className="setup-io-btn" onClick={onOpenAccount}>Mon compte : export et demande de suppression</button>
      : <p>La gestion du compte n'est pas disponible dans cette session.</p>}
    <p>L'export du profil dans ces réglages n'est pas une sauvegarde complète. L'export des données du compte a lui aussi un périmètre propre ; vérifiez son contenu avant toute migration ou suppression.</p>
    <h3>Microphone, caméra et localisation</h3>
    <p>Ces autorisations se gèrent dans le navigateur ou les réglages du système. Aucune autorisation n'est demandée en ouvrant cette page.
      Couper le microphone n'efface pas une transcription déjà reçue. FACE ID est une reconnaissance locale, pas une authentification biométrique certifiée pour une opération sensible.</p>
    <p>Cette page n'active pas de conversation privée ni de désactivation globale de la mémoire : ces protections ne doivent pas être supposées disponibles.</p>
  </section>;
}
