package fr.sirius_assistant.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.lifecycle.Lifecycle;

import java.io.File;

/**
 * Capture micro native continue pour le mode mains libres expérimental (build diagnostic uniquement).
 * Un seul AudioRecord reste ouvert pendant toute la session ; les énoncés sont découpés par
 * {@link UtteranceSegmenter} et transmis en WAV PCM16 mono 16 kHz encodé en base64.
 *
 * <p>La détection de parole est une VAD purement énergétique (RMS par trame de 20 ms avec plancher
 * de bruit adaptatif), et non un modèle neuronal : un bruit fort non vocal peut déclencher un énoncé,
 * et une voix très faible peut être ignorée. Le serveur de transcription reste juge du contenu.
 *
 * <p>Les métadonnées d'énoncé (speechStartMs, endedMs) suivent l'horloge d'échantillons de la session,
 * monotone depuis la première trame lue. Aucun audio brut n'est écrit sur disque ni journalisé.
 *
 * <p>Capture comparative de diagnostic : uniquement avec {@code start({diagnosticCapture:true})}
 * (consentement explicite, défaut false). PCM brut des seules périodes d'écoute non suspendues et segments
 * associés, en WAV dans le cache privé de l'application ({@link DiagnosticRecorder#DIR_NAME}),
 * au plus 3 échantillons de 20 s et 60 s par session. Les fichiers précédents sont effacés à chaque
 * nouvelle session consentie ; diagnosticSamples() ne renvoie que des métadonnées ;
 * deleteDiagnostics() efface tout et arrête la capture en cours.
 *
 * <p>Politique d'état : {@code ready} avec {@code suppressed:false, listening:true} n'est émis qu'après
 * la garde post-reprise de 300 ms, sur des trames réellement lues (ou en retour d'écoute après un énoncé).
 * Le {@code ready} de démarrage ({@code startup:true, listening:false}) n'est émis que si la session est
 * encore suspendue. setSuppressed(false) n'émet rien ; setSuppressed(true) émet {@code paused}.
 * Une erreur d'écriture de diagnostic émet {@code state {phase:'diagnostic-error', code:'DIAGNOSTIC_IO',
 * message}} sans arrêter la voix.
 *
 * <p>Premier plan : la capture ne démarre jamais si l'activité n'est pas au premier plan (resumed).
 * Une permission accordée pendant la pause due à la boîte système est différée jusqu'à onResume ;
 * un vrai passage en arrière-plan (onStop) annule la demande en attente.
 *
 * <p>Toute fin de session (stop, remplacement, arrière-plan, destruction, erreur) émet
 * {@code state {phase:'stopped', reason}} afin que le JS désactive son mode mains libres.
 * Une nouvelle session démarre toujours suspendue ; après stop, setSuppressed ne peut rien reprendre.
 */
@CapacitorPlugin(name = "SiriusAudio", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class SiriusAudioPlugin extends Plugin {
    private static final long START_TIMEOUT_MS = 5000;
    private static final long STOP_JOIN_MS = 1000;
    private static final int FRAME_SAMPLES = UtteranceSegmenter.FRAME_SAMPLES;

    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private long generation;
    private Session session;
    private PluginCall permissionCall;
    private PluginCall resumeCall;
    private boolean resumed;
    private boolean visible;
    private DiagnosticRecorder lastDiagnostics;

    private static final class AudioFailure extends Exception {
        final String code;
        AudioFailure(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private final class Session implements Runnable {
        final long id;
        final PluginCall startCall;
        final UtteranceSegmenter segmenter = new UtteranceSegmenter();
        final DiagnosticRecorder diagnostics;
        final Runnable startTimeout = this::onStartTimeout;
        volatile boolean running = true;
        boolean started;
        final long createdAt = SystemClock.elapsedRealtime();
        AudioRecord record;
        Thread thread;

        Session(long id, PluginCall startCall, DiagnosticRecorder diagnostics) {
            this.id = id;
            this.startCall = startCall;
            this.diagnostics = diagnostics;
        }

        @Override
        public void run() {
            AudioRecord rec = null;
            if (diagnostics != null) {
                diagnostics.open();
                reportDiagnostics(this);
            }
            try {
                int minBuffer = AudioRecord.getMinBufferSize(UtteranceSegmenter.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                if (minBuffer <= 0) throw new AudioFailure("Format micro 16 kHz mono non pris en charge.", "UNAVAILABLE");
                rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, UtteranceSegmenter.SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(minBuffer, FRAME_SAMPLES * 2 * 10));
                synchronized (lock) {
                    if (!isCurrentLocked(this)) return;
                    record = rec;
                }
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                    throw new AudioFailure("Initialisation du micro impossible.", "UNAVAILABLE");
                }
                rec.startRecording();
                if (rec.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                    throw new AudioFailure("Micro occupé par une autre application.", "BUSY");
                }
                short[] frame = new short[FRAME_SAMPLES];
                while (running) {
                    int read = readFrame(rec, frame);
                    if (!running) break;
                    if (read < 0) throw new AudioFailure("Lecture micro échouée (code " + read + ").", "UNAVAILABLE");
                    if (!started) markStarted(this);
                    UtteranceSegmenter.Event event;
                    boolean listening;
                    long epoch;
                    long frameIndex;
                    synchronized (segmenter) {
                        listening = !segmenter.isSuppressed();
                        epoch = segmenter.epoch();
                        frameIndex = segmenter.framesProcessed();
                        event = segmenter.process(frame);
                    }
                    if (diagnostics != null) {
                        diagnostics.onFrame(frame, listening, epoch, frameIndex * FRAME_SAMPLES);
                        if (event != null) diagnostics.onSegment(event);
                        reportDiagnostics(this);
                    }
                    if (event != null) handleEvent(this, event);
                }
            } catch (AudioFailure failure) {
                fail(this, failure.getMessage(), failure.code);
            } catch (SecurityException error) {
                fail(this, "Microphone non autorisé.", "PERMISSION_DENIED");
            } catch (RuntimeException error) {
                fail(this, "Erreur micro : " + error.getMessage(), "UNAVAILABLE");
            } finally {
                if (diagnostics != null) diagnostics.finish("stopped");
                synchronized (lock) {
                    record = null;
                }
                if (rec != null) {
                    try {
                        rec.stop();
                    } catch (IllegalStateException ignored) {
                        // Déjà arrêté ou jamais démarré.
                    }
                    rec.release();
                }
            }
        }

        private int readFrame(AudioRecord rec, short[] frame) {
            int offset = 0;
            while (offset < frame.length && running) {
                int read = rec.read(frame, offset, frame.length - offset);
                if (read < 0) return read;
                if (read == 0) return running ? AudioRecord.ERROR : 0;
                offset += read;
            }
            return offset;
        }

        private void onStartTimeout() {
            fail(this, "Le micro ne fournit aucune trame audio.", "UNAVAILABLE");
        }
    }

    @Override
    public void load() {
        Lifecycle.State state = getActivity().getLifecycle().getCurrentState();
        synchronized (lock) {
            resumed = state.isAtLeast(Lifecycle.State.RESUMED);
            visible = state.isAtLeast(Lifecycle.State.STARTED);
        }
    }

    /** Disponibilité pour l'UI, sans demande de permission : build diagnostic et micro présent. */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", isDiagnosticBuild()
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_MICROPHONE));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!isDiagnosticBuild()) {
            call.reject("SiriusAudio est réservé à la build diagnostic.", "DIAGNOSTIC_ONLY");
            return;
        }
        boolean needsPermission = getPermissionState("microphone") != PermissionState.GRANTED;
        synchronized (lock) {
            stopLocked("Session audio remplacée.", "replaced");
            if (!visible) {
                call.reject("Application en arrière-plan.", "BACKGROUND");
                return;
            }
            if (needsPermission) permissionCall = call;
            else beginWhenResumedLocked(call);
        }
        if (needsPermission) requestPermissionForAlias("microphone", call, "microphonePermission");
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        synchronized (lock) {
            if (permissionCall != call) return;
            permissionCall = null;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                call.reject("Microphone non autorisé.", "PERMISSION_DENIED");
                return;
            }
            beginWhenResumedLocked(call);
        }
    }

    /** Ne démarre la capture qu'au premier plan ; sinon attend onResume (retour de la boîte de permission). */
    private void beginWhenResumedLocked(PluginCall call) {
        if (resumed) beginLocked(call);
        else resumeCall = call;
    }

    /** Métadonnées de capture de diagnostic uniquement ; jamais d'audio. */
    @PluginMethod
    public void diagnosticSamples(PluginCall call) {
        if (!isDiagnosticBuild()) {
            call.reject("SiriusAudio est réservé à la build diagnostic.", "DIAGNOSTIC_ONLY");
            return;
        }
        JSObject result = new JSObject();
        JSArray samples = new JSArray();
        synchronized (lock) {
            DiagnosticRecorder recorder = lastDiagnostics;
            result.put("capturing", recorder != null && recorder.isCapturing());
            if (recorder != null && recorder.error() != null) result.put("error", recorder.error());
            if (recorder != null) {
                for (DiagnosticRecorder.SampleInfo sample : recorder.snapshot()) samples.put(sampleJson(sample));
            }
        }
        JSArray files = new JSArray();
        for (DiagnosticRecorder.FileInfo file : DiagnosticRecorder.listFiles(diagnosticsDir())) {
            JSObject entry = new JSObject();
            entry.put("name", file.name);
            entry.put("bytes", file.bytes);
            files.put(entry);
        }
        result.put("samples", samples);
        result.put("files", files);
        result.put("directory", "cache/" + DiagnosticRecorder.DIR_NAME);
        result.put("packageName", getContext().getPackageName());
        result.put("sampleRate", DiagnosticRecorder.SAMPLE_RATE);
        call.resolve(result);
    }

    /** Effacement explicite de tous les fichiers de diagnostic ; arrête la capture de la session en cours. */
    @PluginMethod
    public void deleteDiagnostics(PluginCall call) {
        if (!isDiagnosticBuild()) {
            call.reject("SiriusAudio est réservé à la build diagnostic.", "DIAGNOSTIC_ONLY");
            return;
        }
        int deleted;
        synchronized (lock) {
            deleted = lastDiagnostics != null ? lastDiagnostics.deleteAll() : 0;
            lastDiagnostics = null;
            deleted += DiagnosticRecorder.deleteDirectory(diagnosticsDir());
        }
        JSObject result = new JSObject();
        result.put("deleted", deleted);
        call.resolve(result);
    }

    private File diagnosticsDir() {
        return new File(getContext().getCacheDir(), DiagnosticRecorder.DIR_NAME);
    }

    private static JSObject sampleJson(DiagnosticRecorder.SampleInfo sample) {
        JSObject json = new JSObject();
        json.put("id", sample.id);
        json.put("file", sample.file);
        json.put("startSample", sample.startSample);
        json.put("sampleCount", sample.sampleCount);
        json.put("durationMs", (long) sample.sampleCount * 1000 / DiagnosticRecorder.SAMPLE_RATE);
        json.put("endReason", sample.endReason);
        JSArray segments = new JSArray();
        for (DiagnosticRecorder.SegmentInfo segment : sample.segments) {
            JSObject entry = new JSObject();
            entry.put("file", segment.file);
            entry.put("sampleCount", segment.sampleCount);
            entry.put("preRollSamples", segment.preRollSamples);
            entry.put("speechStartMs", segment.speechStartMs);
            entry.put("endedMs", segment.endedMs);
            entry.put("reason", segment.reason);
            entry.put("offsetSamples", segment.offsetSamples);
            segments.put(entry);
        }
        json.put("segments", segments);
        return json;
    }

    @PluginMethod
    public void setSuppressed(PluginCall call) {
        Boolean suppressed = call.getBoolean("suppressed");
        if (suppressed == null) {
            call.reject("Paramètre 'suppressed' booléen requis.", "INVALID_ARGUMENT");
            return;
        }
        boolean active;
        synchronized (lock) {
            active = session != null;
            if (active) {
                session.segmenter.setSuppressed(suppressed);
                // La reprise n'émet rien : "ready" viendra du segmenteur après la garde, sur trames réelles.
                if (suppressed && session.started) emitPaused();
            }
        }
        JSObject result = new JSObject();
        result.put("active", active);
        result.put("suppressed", suppressed);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Session previous;
        synchronized (lock) {
            previous = stopLocked("Session audio arrêtée.", "stop");
        }
        boolean released = true;
        if (previous != null) {
            Thread thread = previous.thread;
            if (thread != null) {
                try {
                    thread.join(STOP_JOIN_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                released = !thread.isAlive();
            }
        }
        JSObject result = new JSObject();
        result.put("released", released);
        call.resolve(result);
    }

    @Override
    protected void handleOnStart() {
        synchronized (lock) {
            visible = true;
        }
    }

    @Override
    protected void handleOnResume() {
        synchronized (lock) {
            resumed = true;
            visible = true;
            PluginCall deferred = resumeCall;
            resumeCall = null;
            if (deferred != null) beginLocked(deferred);
        }
    }

    @Override
    protected void handleOnPause() {
        synchronized (lock) {
            resumed = false;
            // La boîte de permission ne provoque qu'onPause : la demande en attente survit jusqu'à onStop.
            stopSessionLocked("Application en arrière-plan.", "background");
        }
    }

    @Override
    protected void handleOnStop() {
        synchronized (lock) {
            resumed = false;
            visible = false;
            stopLocked("Application en arrière-plan.", "background");
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lock) {
            stopLocked("Application fermée.", "destroyed");
        }
    }

    private boolean isDiagnosticBuild() {
        return getContext().getPackageName().endsWith(".diagnostic");
    }

    private boolean isCurrentLocked(Session candidate) {
        return candidate != null && session == candidate && candidate.id == generation;
    }

    private void beginLocked(PluginCall call) {
        DiagnosticRecorder diagnostics = null;
        if (isDiagnosticBuild() && Boolean.TRUE.equals(call.getBoolean("diagnosticCapture", false))) {
            diagnostics = new DiagnosticRecorder(diagnosticsDir());
            lastDiagnostics = diagnostics;
        }
        Session next = new Session(++generation, call, diagnostics);
        session = next;
        next.thread = new Thread(next, "SiriusAudio-" + next.id);
        next.thread.start();
        mainHandler.postDelayed(next.startTimeout, START_TIMEOUT_MS);
    }

    private Session stopLocked(String message, String reason) {
        boolean cancelled = false;
        if (permissionCall != null) {
            permissionCall.reject(message, "CANCELLED");
            permissionCall = null;
            cancelled = true;
        }
        if (resumeCall != null) {
            resumeCall.reject(message, "CANCELLED");
            resumeCall = null;
            cancelled = true;
        }
        Session previous = stopSessionLocked(message, reason);
        // Une demande en attente annulée (hors remplacement) doit aussi désactiver la session côté JS.
        if (previous == null && cancelled && !"replaced".equals(reason)) emitStopped(message, reason);
        return previous;
    }

    private Session stopSessionLocked(String message, String reason) {
        generation++;
        Session previous = session;
        session = null;
        if (previous == null) return null;
        previous.running = false;
        if (previous.diagnostics != null) previous.diagnostics.finish("stopped");
        mainHandler.removeCallbacks(previous.startTimeout);
        if (!previous.started) previous.startCall.reject(message, "CANCELLED");
        if (previous.record != null) {
            try {
                previous.record.stop();
            } catch (IllegalStateException ignored) {
                // Le thread de capture libère l'appareil dans son bloc finally.
            }
        }
        emitStopped(message, reason);
        return previous;
    }

    private void markStarted(Session candidate) {
        synchronized (lock) {
            if (!isCurrentLocked(candidate) || candidate.started) return;
            candidate.started = true;
            mainHandler.removeCallbacks(candidate.startTimeout);
            boolean suppressed = candidate.segmenter.isSuppressed();
            long firstReadMs = SystemClock.elapsedRealtime() - candidate.createdAt;
            JSObject result = new JSObject();
            result.put("sampleRate", UtteranceSegmenter.SAMPLE_RATE);
            result.put("frameMs", UtteranceSegmenter.FRAME_MS);
            result.put("suppressed", suppressed);
            result.put("firstReadMs", firstReadMs);
            candidate.startCall.resolve(result);
            // "ready" de démarrage = AudioRecord livre des trames ; ni écoute ni preuve de signal audible.
            // Si le JS a déjà repris, on laisse le seul "ready" post-garde signaler l'écoute.
            if (suppressed) {
                JSObject state = new JSObject();
                state.put("phase", "ready");
                state.put("startup", true);
                state.put("suppressed", true);
                state.put("listening", false);
                state.put("firstReadMs", firstReadMs);
                notifyListeners("state", state);
            }
        }
    }

    private void handleEvent(Session candidate, UtteranceSegmenter.Event event) {
        String audio = event.type == UtteranceSegmenter.Type.UTTERANCE
            ? Base64.encodeToString(UtteranceSegmenter.toWav(event.pcm, UtteranceSegmenter.SAMPLE_RATE), Base64.NO_WRAP)
            : null;
        synchronized (lock) {
            if (!isCurrentLocked(candidate) || !candidate.segmenter.isCurrent(event)) return;
            if (event.type == UtteranceSegmenter.Type.READY) {
                emitListening("resume", event.endedMs);
                return;
            }
            if (event.type == UtteranceSegmenter.Type.SPEECH_START) {
                emitState("speech", null, null);
                return;
            }
            if (audio != null) {
                JSObject utterance = new JSObject();
                utterance.put("audio", audio);
                utterance.put("durationMs", event.durationMs);
                utterance.put("sampleCount", event.sampleCount);
                utterance.put("preRollSamples", event.preRollSamples);
                utterance.put("speechStartMs", event.speechStartMs);
                utterance.put("endedMs", event.endedMs);
                utterance.put("reason", event.reason);
                utterance.put("maxLength", event.maxLength);
                notifyListeners("utterance", utterance);
            }
            emitListening(audio != null ? "utterance" : "discarded", event.endedMs);
        }
    }

    private void reportDiagnostics(Session candidate) {
        String failure = candidate.diagnostics.consumeFailure();
        if (failure == null) return;
        synchronized (lock) {
            if (!isCurrentLocked(candidate)) return;
            emitState("diagnostic-error", failure, "DIAGNOSTIC_IO");
        }
    }

    private void emitListening(String cause, long atMs) {
        JSObject state = new JSObject();
        state.put("phase", "ready");
        state.put("suppressed", false);
        state.put("listening", true);
        state.put("cause", cause);
        state.put("atMs", atMs);
        notifyListeners("state", state);
    }

    private void emitPaused() {
        JSObject state = new JSObject();
        state.put("phase", "paused");
        state.put("suppressed", true);
        state.put("listening", false);
        notifyListeners("state", state);
    }

    private void fail(Session candidate, String message, String code) {
        boolean emit;
        synchronized (lock) {
            if (!isCurrentLocked(candidate)) return;
            emit = candidate.started;
            generation++;
            session = null;
            candidate.running = false;
            if (candidate.diagnostics != null) candidate.diagnostics.finish("error");
            mainHandler.removeCallbacks(candidate.startTimeout);
            if (candidate.record != null) {
                try {
                    candidate.record.stop();
                } catch (IllegalStateException ignored) {
                    // Libéré par le thread de capture.
                }
            }
            if (!emit) candidate.startCall.reject(message, code);
            else emitState("error", message, code);
            emitStopped(message, "error");
        }
    }

    private void emitStopped(String message, String reason) {
        JSObject state = new JSObject();
        state.put("phase", "stopped");
        state.put("reason", reason);
        if (message != null) state.put("message", message);
        notifyListeners("state", state);
    }


    private void emitState(String phase, String message, String code) {
        JSObject state = new JSObject();
        state.put("phase", phase);
        if (message != null) state.put("message", message);
        if (code != null) state.put("code", code);
        notifyListeners("state", state);
    }
}
