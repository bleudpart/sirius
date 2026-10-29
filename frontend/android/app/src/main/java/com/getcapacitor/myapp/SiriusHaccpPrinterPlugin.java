package fr.sirius_assistant.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.Log;

import com.brother.sdk.lmprinter.Channel;
import com.brother.sdk.lmprinter.GetStatusError;
import com.brother.sdk.lmprinter.GetStatusResult;
import com.brother.sdk.lmprinter.OpenChannelError;
import com.brother.sdk.lmprinter.PrintError;
import com.brother.sdk.lmprinter.PrinterDriver;
import com.brother.sdk.lmprinter.PrinterDriverGenerateResult;
import com.brother.sdk.lmprinter.PrinterDriverGenerator;
import com.brother.sdk.lmprinter.PrinterModel;
import com.brother.sdk.lmprinter.PrinterStatus;
import com.brother.sdk.lmprinter.setting.PrintImageSettings;
import com.brother.sdk.lmprinter.setting.QLPrintSettings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

@CapacitorPlugin(name = "SiriusHaccpPrinter", permissions = {
    @Permission(alias = "localNetwork", strings = {"android.permission.ACCESS_LOCAL_NETWORK"})
})
public class SiriusHaccpPrinterPlugin extends Plugin {
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();
    private static final AtomicBoolean busy = new AtomicBoolean();
    private volatile boolean foreground;
    private SharedPreferences prefs;
    private static final Set<String> JOB_KEYS = new HashSet<>(Arrays.asList("id", "labelId", "product", "lot", "opened", "deadline", "operator"));

    @Override public void load() {
        prefs = getContext().getSharedPreferences("sirius_haccp_printer", Context.MODE_PRIVATE);
        foreground = true;
        if (!prefs.contains("device_id") && !prefs.edit().putString("device_id", UUID.randomUUID().toString()).commit()) {
            throw new IllegalStateException("Identite du telephone non sauvegardee.");
        }
    }

    @Override protected void handleOnResume() { foreground = true; }
    @Override protected void handleOnPause() { foreground = false; }
    @Override protected void handleOnDestroy() { foreground = false; }

    private JSObject config() {
        JSObject result = new JSObject();
        result.put("deviceId", prefs.getString("device_id", ""));
        result.put("ip", prefs.getString("ip", ""));
        result.put("enabled", prefs.getBoolean("enabled", false));
        result.put("model", "QL-820NWB");
        result.put("roll", "DK-22205");
        result.put("widthMm", 62);
        result.put("heightMm", 50);
        result.put("networkGranted", networkGranted());
        return result;
    }

    @PluginMethod public void getConfig(PluginCall call) { call.resolve(config()); }

    private boolean networkGranted() {
        return Build.VERSION.SDK_INT < 37 || getPermissionState("localNetwork") == PermissionState.GRANTED;
    }

    @PluginMethod public void requestNetworkAccess(PluginCall call) {
        if (networkGranted()) { networkPermissionResult(call); return; }
        requestPermissionForAlias("localNetwork", call, "networkPermissionResult");
    }

    @PermissionCallback private void networkPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", networkGranted());
        call.resolve(result);
    }

    @PluginMethod public void configure(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("Impression deja en cours."); return; }
        try {
            String ip = HaccpPrinterRules.privateIpv4(call.getString("ip"));
            if (call.getBoolean("enabled", false) && !networkGranted()) {
                throw new IllegalStateException("Autorisez l'acces au reseau local dans les permissions Android.");
            }
            if (!"QL-820NWB".equals(call.getString("model")) || !"DK-22205".equals(call.getString("roll"))
                    || call.getInt("widthMm", 0) != 62 || call.getInt("heightMm", 0) != 50) {
                throw new IllegalArgumentException("Uniquement Brother QL-820NWB, DK-22205, 62 x 50 mm.");
            }
            if (!prefs.edit().putString("ip", ip).putBoolean("enabled", call.getBoolean("enabled", false)).commit()) {
                throw new IllegalStateException("Configuration non sauvegardee.");
            }
            call.resolve(config());
        } catch (Exception error) { call.reject(error.getMessage()); }
        finally { busy.set(false); }
    }

    @PluginMethod public void printJob(PluginCall call) { begin(call, false); }
    @PluginMethod public void printTest(PluginCall call) { begin(call, true); }

    private Bitmap render(JSObject job, boolean test) {
        // DK-22205 : largeur imprimable Brother 696 points a 300 dpi ; coupe a 50 mm.
        Bitmap bitmap = Bitmap.createBitmap(696, 591, Bitmap.Config.ARGB_8888);
        bitmap.setDensity(300);
        try {
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.WHITE);
            String header;
            String product;
            String body;
            if (test) {
                header = "SIRIUS · TEST — HORS REGISTRE";
                product = "TEST BROTHER QL-820NWB";
                body = "DK-22205 · 62 x 50 mm\nVerifier marges, lisibilite et coupe.\nAUCUNE DENREE — NE PAS COLLER";
            } else {
                Iterator<String> keys = job.keys();
                while (keys.hasNext()) if (!JOB_KEYS.contains(keys.next())) {
                    throw new IllegalArgumentException("Payload d'etiquette non autorise.");
                }
                Integer labelId = job.getInteger("labelId");
                if (labelId == null || labelId <= 0) throw new IllegalArgumentException("Fiche invalide.");
                header = "ΣIRIUS · OUVERTURE #" + labelId;
                product = HaccpPrinterRules.text(job.getString("product"), 255);
                body = "Lot : " + HaccpPrinterRules.text(job.getString("lot"), 128)
                    + "\nOuvert : " + HaccpPrinterRules.text(job.getString("opened"), 40)
                    + "\nAu plus tard : " + HaccpPrinterRules.text(job.getString("deadline"), 40)
                    + "\nOperateur : " + HaccpPrinterRules.text(job.getString("operator"), 100);
            }
            int y = line(canvas, header, 18, 30, true);
            y = line(canvas, product, y + 8, 40, true);
            y = line(canvas, body, y + 10, 34, false);
            y = line(canvas, "Europe/Paris · Respecter les consignes fabricant/PMS. Regle et original conserves au registre.",
                y + 12, 28, false);
            if (y > 573) throw new IllegalArgumentException("Etiquette trop longue pour 62 x 50 mm : aucune impression, aucune troncature.");
            return bitmap;
        } catch (RuntimeException error) { bitmap.recycle(); throw error; }
    }

    private int line(Canvas canvas, String text, int top, int size, boolean bold) {
        TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.BLACK);
        paint.setTextSize(size);
        paint.setTypeface(bold ? Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) : Typeface.SANS_SERIF);
        StaticLayout layout = StaticLayout.Builder.obtain(text, 0, text.length(), paint, 660)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(false).build();
        if (top + layout.getHeight() > 573) throw new IllegalArgumentException("Debordement etiquette : reduire le contenu, aucune troncature.");
        canvas.save();
        canvas.translate(18, top);
        layout.draw(canvas);
        canvas.restore();
        return top + layout.getHeight();
    }

    private void begin(PluginCall call, boolean test) {
        if (!foreground || getActivity() == null || getActivity().isFinishing()) {
            call.reject("Gardez SIRIUS au premier plan pour imprimer."); return;
        }
        if (!busy.compareAndSet(false, true)) { call.reject("Impression deja en cours, aucun nouvel envoi."); return; }
        try {
            if (!prefs.getBoolean("enabled", false)) throw new IllegalStateException("Imprimante Android desactivee.");
            if (!networkGranted()) throw new IllegalStateException("Permission reseau local Android refusee.");
            ConnectivityManager network = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkCapabilities capabilities = network.getNetworkCapabilities(network.getActiveNetwork());
            if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                throw new IllegalStateException("Connectez ce telephone au Wi-Fi de l'imprimante (sans VPN).");
            }
            String ip = HaccpPrinterRules.privateIpv4(prefs.getString("ip", ""));
            JSObject job = test ? new JSObject() : call.getObject("job");
            if (job == null) throw new IllegalArgumentException("Demande serveur requise.");
            String id = test ? "test-" + UUID.randomUUID() : HaccpPrinterRules.jobId(job.getString("id"));
            String key = "job:" + id;
            if (prefs.contains(key)) throw new IllegalStateException("Demande deja journalisee : verifier le papier, aucune reimpression.");
            Bitmap bitmap = render(job, test);
            JSObject journal = new JSObject();
            journal.put("id", id);
            journal.put("labelId", test ? 0 : job.getInteger("labelId"));
            journal.put("status", "uncertain");
            journal.put("createdAt", System.currentTimeMillis());
            journal.put("ip", ip);
            journal.put("model", "QL-820NWB");
            journal.put("roll", "DK-22205");
            journal.put("widthMm", 62);
            journal.put("heightMm", 50);
            if (!prefs.edit().putString(key, journal.toString()).commit()) {
                bitmap.recycle();
                throw new IllegalStateException("Journal durable indisponible : aucun envoi.");
            }
            worker.execute(() -> send(call, key, ip, bitmap, journal));
        } catch (Exception error) {
            busy.set(false);
            call.reject(error.getMessage());
        }
    }

    private void send(PluginCall call, String key, String ip, Bitmap bitmap, JSObject journal) {
        AtomicBoolean finished = new AtomicBoolean();
        AtomicReference<PrinterDriver> driverRef = new AtomicReference<>();
        ScheduledFuture<?> deadline = watchdog.schedule(() -> {
            if (finished.compareAndSet(false, true)) {
                // Le journal est deja incertain. Ne pas liberer busy tant que le SDK n'est pas sorti.
                complete(call, false, "TIMEOUT_45S : resultat incertain, verifier le papier. Aucun nouvel essai.");
                PrinterDriver active = driverRef.get();
                if (active != null) {
                    try { active.cancelPrinting(); }
                    catch (RuntimeException error) { Log.w("SiriusHaccpPrinter", "Annulation SDK non confirmee apres expiration du delai.", error); }
                }
            }
        }, 45, TimeUnit.SECONDS);
        PrinterDriver driver = null;
        boolean accepted = false;
        String detail = "Impression non confirmee.";
        try {
            if (!foreground || finished.get()) throw new IllegalStateException("SIRIUS n'est plus au premier plan.");
            PrinterDriverGenerateResult opened = PrinterDriverGenerator.openChannel(Channel.newWifiChannel(ip));
            if (opened.getError().getCode() != OpenChannelError.ErrorCode.NoError) {
                throw new IllegalStateException("Connexion Brother : " + opened.getError().getCode());
            }
            driver = opened.getDriver();
            driverRef.set(driver);
            if (!foreground || finished.get()) throw new IllegalStateException("Connexion abandonnee, aucun nouvel envoi.");
            GetStatusResult state = driver.getPrinterStatus();
            if (state.getError().getCode() != GetStatusError.ErrorCode.NoError || state.getPrinterStatus() == null) {
                throw new IllegalStateException("Etat Brother inaccessible : " + state.getError().getCode());
            }
            if (state.getPrinterStatus().getModel() != PrinterModel.QL_820NWB) {
                throw new IllegalStateException("Modele physique non autorise : Brother QL-820NWB requis.");
            }
            if (state.getPrinterStatus().getErrorCode() != PrinterStatus.ErrorCode.NoError) {
                throw new IllegalStateException("Etat imprimante : " + state.getPrinterStatus().getErrorCode());
            }
            if (!foreground || finished.get()) throw new IllegalStateException("Impression abandonnee avant transmission.");
            QLPrintSettings settings = new QLPrintSettings(PrinterModel.QL_820NWB);
            settings.setLabelSize(QLPrintSettings.LabelSize.RollW62);
            settings.setResolution(PrintImageSettings.Resolution.Normal);
            settings.setScaleMode(PrintImageSettings.ScaleMode.ActualSize);
            settings.setAutoCut(true);
            settings.setCutAtEnd(true);
            settings.setNumCopies(1);
            settings.setSkipStatusCheck(false);
            settings.setTrimTrailingBlankData(false);
            settings.setFeedDirectionMargins(0);
            settings.setWorkPath(getContext().getFilesDir().getAbsolutePath());
            PrintError result = driver.printImage(bitmap, settings);
            accepted = result.getCode() == PrintError.ErrorCode.NoError;
            detail = accepted ? "SDK Brother sans erreur. Verifiez la sortie papier."
                : "Brother : " + result.getCode() + ". Verifiez batterie, papier, rouleau et reseau. Aucun nouvel essai.";
        } catch (Exception error) {
            detail = error.getMessage() == null ? "Erreur Brother, resultat incertain." : error.getMessage();
        } finally {
            if (finished.compareAndSet(false, true)) {
                deadline.cancel(false);
                if (accepted) {
                    journal.put("status", "accepted");
                    journal.put("updatedAt", System.currentTimeMillis());
                    if (!prefs.edit().putString(key, journal.toString()).commit()) {
                        accepted = false;
                        detail = "Transmission effectuee mais journal non confirme : verifier le papier.";
                    }
                }
                complete(call, accepted, detail);
            }
            try { if (driver != null) driver.closeChannel(); }
            catch (Exception error) { Log.w("SiriusHaccpPrinter", "Fermeture de la connexion Brother non confirmee ; aucun nouvel envoi.", error); }
            bitmap.recycle();
            busy.set(false);
        }
    }

    private void complete(PluginCall call, boolean accepted, String detail) {
        JSObject result = new JSObject();
        result.put("accepted", accepted);
        result.put("detail", detail);
        call.resolve(result);
    }
}
