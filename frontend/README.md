# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Available Scripts

## Navigation sur téléphone

Sous 600 px, la navigation est un tiroir replié en bas de l'écran. Faites glisser
la poignée « Menu » vers le haut pour afficher Accueil, Infos, Assistant, Modules
et Réglages, puis vers le bas pour les masquer. Un appui sur la poignée fonctionne
aussi. Le tiroir se replie après le choix d'une rubrique et ne redimensionne pas
le dialogue lorsqu'il s'ouvre. La navigation latérale sur tablette reste inchangée.

Le réacteur utilise son rendu allégé sur mobile : moins de détails et pas de flou
canvas. Les animations de bordure tactiles sont également moins fréquentes.
Ces optimisations ne modifient ni la reconnaissance vocale ni les protections
thermiques du système Android.

In the project directory, you can run:

## Scanner et documents papier

Le scanner est accessible dans la médiathèque et dans « Mes dossiers ». Il conserve
la photo originale sur le serveur SIRIUS après confirmation. La lecture du texte
se fait localement avec les ressources OCR embarquées ; les champs extraits doivent
être relus avant enregistrement. Le mode Achat prépare une fiche de dépense ;
le mode Vente prépare un brouillon de facture non émis.
La copie destinée à l'OCR est redimensionnée et redressée sans modifier la photo
originale. Une incohérence de longueur ou de clé SIRET/SIREN déclenche une alerte
et demande une comparaison explicite avec la photo ; aucun chiffre n'est inventé.
Ce contrôle ne vérifie pas l'existence du commerce dans un registre officiel.
Sur Android, AAPT décompresse le modèle `.gz` dans l'APK : le lecteur demande
donc le modèle `.traineddata` non compressé. Le navigateur et iOS gardent `.gz`.

Les modèles PDF A4 classique et professionnel incluent sur chaque page la signature
ΣIRIUS avec l'icône des e-mails et les coordonnées de signature du compte.
Le champ « Nom affiché » des signatures est prioritaire sur le nom du profil.
Cette présentation n'est pas une signature électronique certifiée et ne remplace
ni les mentions obligatoires ni la validation comptable du justificatif.

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)
