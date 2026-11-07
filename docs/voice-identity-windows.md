# Reconnaissance du locuteur dans le paquet Windows

Le paquet Windows contient le runtime optionnel nécessaire à la vérification du
locuteur :

- le worker isolé `sirius-voice-worker.exe` et le module natif `sherpa-onnx` ;
- le modèle WeSpeaker `wespeaker_en_voxceleb_resnet34_LM.onnx`, vérifié par SHA-256 ;
- `ffmpeg.exe` et ses bibliothèques partagées issues d'un build LGPL ;
- les notices du modèle et la licence FFmpeg.

Les téléchargements de build sont épinglés par SHA-256 dans
[`scripts/prepare_voice_identity_assets.py`](../scripts/prepare_voice_identity_assets.py).
Les actifs générés restent dans `backend/build/` et ne sont pas ajoutés au dépôt.
Le build Windows échoue si un actif est absent, altéré ou incomplet. Les composants
exécutables et DLL du paquet passent ensuite dans le contrôle de signature Windows.

## Désactivation par défaut

Inclure le moteur ne l'active pas. La reconnaissance reste désactivée tant que
l'exploitant n'a pas calibré un seuil approprié et donné la configuration explicite.
Le backend refuse de démarrer la vérification si le seuil manque, si le modèle ou
son empreinte SHA-256 ne correspondent pas, ou si le décodeur est indisponible.
Le bouton micro maintenu reste utilisable lorsque cette fonction est désactivée.

Electron injecte le chemin du modèle, son SHA-256 approuvé et le chemin de FFmpeg
depuis les ressources du paquet. Dans le `.env` du dossier de données utilisé par
l'application, l'exploitant devra ensuite définir :

```dotenv
SIRIUS_VOICE_IDENTITY_ENABLED=1
SIRIUS_VOICE_IDENTITY_THRESHOLD=<seuil calibré entre 0.75 et 0.99>
```

Ne pas copier une valeur issue d'un test synthétique ou d'un autre locuteur. Le
seuil influe sur les faux rejets de l'utilisateur et les fausses acceptations
d'autres voix. Il doit être évalué à partir d'échantillons locaux représentatifs :
plusieurs phrases du propriétaire, d'autres locuteurs, bruit de fond et télévision.
Si les scores positifs et négatifs se recouvrent, ne pas activer l'écoute continue.
Le score cosinus n'est pas une probabilité ni une authentification forte.

L'écran « Ma voix » demande un consentement avant l'inscription et la conservation
du gabarit vocal. Les échantillons audio sont traités en mémoire et ne sont pas
persistés ; seul le gabarit est conservé dans la base utilisée par le backend
(stockage local en mode local-first, ou MongoDB si configuré). L'utilisateur peut
supprimer son gabarit depuis le même écran.

## Licences des actifs distribués

- Le modèle WeSpeaker est fourni sous **CC BY 4.0**. Le paquet inclut sa notice
  d'attribution ; la provenance, la licence et le SHA-256 sont inscrits dans
  `voice-runtime/NOTICE.txt`.
- FFmpeg est fourni sous **GNU LGPL v3** avec bibliothèques partagées. Le texte de
  licence est distribué sous `voice-runtime/ffmpeg/LICENSE.txt`. Voir également
  [FFmpeg](https://ffmpeg.org/legal.html) et le dépôt des
  [builds Windows LGPL](https://github.com/FFmpeg-Builds/FFmpeg-Builds).

Avant une distribution publique, vérifier que les obligations de fourniture du
code source correspondant à cette version et de relinkage de la LGPL sont remplies.
