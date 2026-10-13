using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class VaultCrypto
{
    [StructLayout(LayoutKind.Sequential)]
    private struct AuthInfo
    {
        public int Size, Version;
        public IntPtr Nonce;
        public int NonceLength;
        public IntPtr AuthData;
        public int AuthDataLength;
        public IntPtr Tag;
        public int TagLength;
        public IntPtr MacContext;
        public int MacContextLength, AadLength;
        public long DataLength;
        public int Flags;
    }

    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptOpenAlgorithmProvider(out IntPtr algorithm, string id, string implementation, int flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptSetProperty(IntPtr handle, string name, byte[] value, int length, int flags);
    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int BCryptGetProperty(IntPtr handle, string name, out int value, int size, out int result, int flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptGenerateSymmetricKey(IntPtr algorithm, out IntPtr key, IntPtr keyObject, int objectLength, byte[] secret, int secretLength, int flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptEncrypt(IntPtr key, byte[] input, int inputLength, ref AuthInfo info, IntPtr iv, int ivLength, byte[] output, int outputLength, out int result, int flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDestroyKey(IntPtr key);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptCloseAlgorithmProvider(IntPtr algorithm, int flags);
    [DllImport("bcrypt.dll")]
    private static extern int BCryptDeriveKeyPBKDF2(IntPtr algorithm, byte[] password, int passwordLength, byte[] salt, int saltLength, ulong iterations, byte[] key, int keyLength, int flags);

    private static void Check(int status)
    {
        if (status != 0) throw new CryptographicException("Erreur du chiffrement Windows : 0x" + status.ToString("X8"));
    }

    private static byte[] RandomBytes(int count)
    {
        byte[] bytes = new byte[count];
        using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        return bytes;
    }

    private static byte[] Derive(string password, byte[] salt)
    {
        IntPtr algorithm = IntPtr.Zero;
        byte[] input = Encoding.UTF8.GetBytes(password);
        byte[] key = new byte[32];
        try
        {
            Check(BCryptOpenAlgorithmProvider(out algorithm, "SHA256", null, 8));
            Check(BCryptDeriveKeyPBKDF2(algorithm, input, input.Length, salt, salt.Length, 600000, key, key.Length, 0));
            return key;
        }
        finally
        {
            if (algorithm != IntPtr.Zero) BCryptCloseAlgorithmProvider(algorithm, 0);
            Array.Clear(input, 0, input.Length);
        }
    }

    private static byte[] Encrypt(byte[] secret, byte[] iv, byte[] plaintext)
    {
        IntPtr algorithm = IntPtr.Zero, key = IntPtr.Zero, keyObject = IntPtr.Zero;
        byte[] aad = Encoding.UTF8.GetBytes("SIRIUS-VAULT-1");
        byte[] tag = new byte[16];
        GCHandle noncePin = default(GCHandle), aadPin = default(GCHandle), tagPin = default(GCHandle);
        try
        {
            Check(BCryptOpenAlgorithmProvider(out algorithm, "AES", null, 0));
            byte[] mode = Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            Check(BCryptSetProperty(algorithm, "ChainingMode", mode, mode.Length, 0));
            int objectLength, received;
            Check(BCryptGetProperty(algorithm, "ObjectLength", out objectLength, sizeof(int), out received, 0));
            keyObject = Marshal.AllocHGlobal(objectLength);
            Check(BCryptGenerateSymmetricKey(algorithm, out key, keyObject, objectLength, secret, secret.Length, 0));
            noncePin = GCHandle.Alloc(iv, GCHandleType.Pinned);
            aadPin = GCHandle.Alloc(aad, GCHandleType.Pinned);
            tagPin = GCHandle.Alloc(tag, GCHandleType.Pinned);
            var info = new AuthInfo {
                Size = Marshal.SizeOf(typeof(AuthInfo)), Version = 1,
                Nonce = noncePin.AddrOfPinnedObject(), NonceLength = iv.Length,
                AuthData = aadPin.AddrOfPinnedObject(), AuthDataLength = aad.Length,
                Tag = tagPin.AddrOfPinnedObject(), TagLength = tag.Length
            };
            byte[] ciphertext = new byte[plaintext.Length];
            int written;
            Check(BCryptEncrypt(key, plaintext, plaintext.Length, ref info, IntPtr.Zero, 0, ciphertext, ciphertext.Length, out written, 0));
            if (written != plaintext.Length) throw new CryptographicException("Longueur du coffre chiffré incorrecte.");
            byte[] result = new byte[written + tag.Length];
            Buffer.BlockCopy(ciphertext, 0, result, 0, written);
            Buffer.BlockCopy(tag, 0, result, written, tag.Length);
            return result;
        }
        finally
        {
            if (key != IntPtr.Zero) BCryptDestroyKey(key);
            if (keyObject != IntPtr.Zero) Marshal.FreeHGlobal(keyObject);
            if (algorithm != IntPtr.Zero) BCryptCloseAlgorithmProvider(algorithm, 0);
            if (noncePin.IsAllocated) noncePin.Free();
            if (aadPin.IsAllocated) aadPin.Free();
            if (tagPin.IsAllocated) tagPin.Free();
        }
    }

    public static string Create(Dictionary<string, string> keys, string password)
    {
        if (password.Length < 12 || password.Length > 1024)
            throw new ArgumentException("Choisissez un mot de passe de 12 à 1024 caractères.");
        if (keys.Count == 0) throw new ArgumentException("Ajoutez au moins une clé.");
        foreach (string value in keys.Values)
            if (value.Length > 4096) throw new ArgumentException("Une clé dépasse 4096 caractères.");
        var json = new JavaScriptSerializer();
        byte[] salt = RandomBytes(16), iv = RandomBytes(12), secret = null;
        byte[] plaintext = Encoding.UTF8.GetBytes(json.Serialize(new { keys = keys }));
        try
        {
            secret = Derive(password, salt);
            byte[] ciphertext = Encrypt(secret, iv, plaintext);
            return json.Serialize(new {
                format = "sirius.vault", version = 1, kdf = "PBKDF2-SHA256", iterations = 600000,
                cipher = "AES-256-GCM", salt = Convert.ToBase64String(salt),
                iv = Convert.ToBase64String(iv), ciphertext = Convert.ToBase64String(ciphertext)
            });
        }
        finally
        {
            if (secret != null) Array.Clear(secret, 0, secret.Length);
            Array.Clear(plaintext, 0, plaintext.Length);
        }
    }
}

internal sealed class VaultForm : Form
{
    private readonly Dictionary<string, TextBox> fields = new Dictionary<string, TextBox>();
    private readonly TextBox password = new TextBox(), confirmation = new TextBox();
    private readonly Button create = new Button();
    private readonly Label status = new Label();
    private readonly TableLayoutPanel layout = new TableLayoutPanel();

    public VaultForm()
    {
        Text = "SIRIUS — Coffre portable";
        ClientSize = new Size(590, 610);
        MinimumSize = new Size(520, 640);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        layout.Dock = DockStyle.Fill;
        layout.Padding = new Padding(18);
        layout.ColumnCount = 2;
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 155));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.AutoScroll = true;
        Controls.Add(layout);
        AddWide(new Label { Text = "Créez votre sauvegarde, puis importez-la dans SIRIUS.\nAucun réseau. Laissez les services inutilisés vides.", AutoSize = true, Margin = new Padding(0, 0, 0, 16) });
        foreach (var service in new[] {
            new[] { "cerebras", "Cerebras" }, new[] { "groq_key", "Groq (voix)" },
            new[] { "serp", "SerpAPI" }, new[] { "fal", "fal.ai" },
            new[] { "gmaps", "Google Maps" }, new[] { "alphavantage", "Alpha Vantage" },
            new[] { "google_tts", "Google TTS" }, new[] { "gemini_tts", "Gemini TTS" }
        })
        {
            var field = new TextBox();
            fields.Add(service[0], field);
            AddField(service[1], field, 4096);
        }
        AddField("Mot de passe", password, 1024);
        AddField("Confirmation", confirmation, 1024);
        AddWide(new Label { Text = "Mot de passe : 12 caractères minimum. Gardez-le séparément.\nIl ne peut pas être récupéré. Les clés seront testées à l'import.", AutoSize = true, Margin = new Padding(0, 8, 0, 8) });
        create.Text = "Créer le coffre…";
        create.AutoSize = true;
        create.Padding = new Padding(12, 6, 12, 6);
        create.Click += CreateClick;
        AddWide(create);
        status.AutoSize = true;
        status.MaximumSize = new Size(520, 0);
        status.Margin = new Padding(0, 12, 0, 0);
        status.Text = "Prêt. Aucun secret n'est enregistré avant votre confirmation.";
        AddWide(status);
    }

    private void AddWide(Control control)
    {
        int row = layout.RowCount++;
        layout.Controls.Add(control, 0, row);
        layout.SetColumnSpan(control, 2);
    }

    private void AddField(string name, TextBox box, int limit)
    {
        int row = layout.RowCount++;
        layout.Controls.Add(new Label { Text = name, AutoSize = true, Anchor = AnchorStyles.Left }, 0, row);
        box.UseSystemPasswordChar = true;
        box.MaxLength = limit;
        box.Dock = DockStyle.Fill;
        box.Margin = new Padding(0, 4, 0, 4);
        layout.Controls.Add(box, 1, row);
    }

    private async void CreateClick(object sender, EventArgs args)
    {
        var keys = new Dictionary<string, string>();
        foreach (var item in fields)
            if (!string.IsNullOrWhiteSpace(item.Value.Text)) keys.Add(item.Key, item.Value.Text.Trim());
        if (keys.Count == 0 || password.Text.Length < 12 || password.Text != confirmation.Text)
        {
            status.ForeColor = Color.Firebrick;
            status.Text = "Ajoutez au moins une clé et deux mots de passe identiques d'au moins 12 caractères.";
            return;
        }
        string destination;
        using (var dialog = new SaveFileDialog {
            Filter = "Coffre SIRIUS (*.vault)|*.vault", FileName = "sirius.vault",
            DefaultExt = "vault", AddExtension = true, OverwritePrompt = true
        })
        {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            destination = dialog.FileName;
        }
        if (File.Exists(destination))
        {
            status.ForeColor = Color.Firebrick;
            status.Text = "Ce fichier existe déjà. Choisissez un autre nom ; il ne sera pas écrasé.";
            return;
        }
        string pass = password.Text;
        layout.Enabled = false;
        ControlBox = false;
        UseWaitCursor = true;
        status.ForeColor = Color.DarkBlue;
        status.Text = "Chiffrement en cours… La fenêtre reste réactive. Patientez.";
        try
        {
            string content = await Task.Run(() => VaultCrypto.Create(keys, pass));
            using (var stream = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                writer.Write(content);
            foreach (TextBox field in fields.Values) field.Clear();
            password.Clear();
            confirmation.Clear();
            status.ForeColor = Color.DarkGreen;
            status.Text = "Coffre créé : " + destination + "\nDans SIRIUS : Clés API et services → Importer mon coffre.";
        }
        catch (Exception error)
        {
            if (!(error is IOException || error is UnauthorizedAccessException ||
                  error is CryptographicException || error is ArgumentException)) throw;
            status.ForeColor = Color.Firebrick;
            status.Text = "Création impossible : " + error.Message;
        }
        finally
        {
            keys.Clear();
            layout.Enabled = true;
            ControlBox = true;
            UseWaitCursor = false;
        }
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--test-fixture")
        {
            try
            {
                string content = VaultCrypto.Create(new Dictionary<string, string> {
                    { "cerebras", "test-secret-not-real" }, { "groq_key", "test-voice-not-real" }
                }, "test-password-123");
                using (var stream = new FileStream(args[1], FileMode.CreateNew))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(content);
                return 0;
            }
            catch (Exception) { return 1; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new VaultForm());
        return 0;
    }
}
