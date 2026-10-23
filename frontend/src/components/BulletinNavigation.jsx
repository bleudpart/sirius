export default function BulletinNavigation({ navigation, onCommand }) {
  if (!navigation?.count) return null;
  return <section className="bulletin-navigation" aria-label="Parcourir le bulletin">
    <p role="status">{navigation.position >= 0
      ? `Titre ${navigation.position + 1} sur ${navigation.count} : ${navigation.title}`
      : `${navigation.count} titres dans ce bulletin.`}</p>
    <div className="workspace-shortcuts">
      <button type="button" disabled={navigation.previousAt === null} onClick={() => onCommand("titre précédent du bulletin")}>Titre précédent</button>
      <button type="button" disabled={navigation.nextAt === null} onClick={() => onCommand("titre suivant du bulletin")}>Titre suivant</button>
      <button type="button" disabled={navigation.position < 0} onClick={() => onCommand(`développe le titre ${navigation.position + 1} du bulletin`)}>Développer ce titre</button>
      <button type="button" disabled={navigation.finished} onClick={() => onCommand("reprends le bulletin")}>Reprendre le bulletin</button>
    </div>
  </section>;
}
