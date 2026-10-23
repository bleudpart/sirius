package fr.sirius_assistant.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.audiofx.Equalizer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

public class SiriusPlaybackService extends Service {
    private static final String CHANNEL = "sirius_playback";
    private static final int NOTIFICATION = 4102;
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static Session pending;
    private static SiriusPlaybackService instance;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<File> files = new HashSet<>();
    private volatile Session session;
    private ExecutorService workers;
    private MediaPlayer player;
    private Equalizer equalizer;
    private MediaSession mediaSession;
    private AudioManager audioManager;
    private AudioFocusRequest focus;
    private volatile boolean running;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        if (change < 0 && running) {
            finish("error", "audio-focus", "Lecture interrompue par une autre application audio.");
        }
    };
    private PowerManager.WakeLock wakeLock;
    private CountDownLatch playbackDone;
    private int index;
    private PlaybackProgress playbackProgress;

    static final class Session {
        final String id;
        final String endpoint;
        final String cookie;
        final String accessToken;
        final JSArray items;
        final JSObject equalizer;
        final Consumer<JSObject> events;
        volatile HttpURLConnection connection;

        Session(String id, String endpoint, String cookie, String accessToken, JSArray items,
                JSObject equalizer, Consumer<JSObject> events) {
            this.id = id;
            this.endpoint = endpoint;
            this.cookie = cookie;
            this.accessToken = accessToken;
            this.items = items;
            this.equalizer = equalizer;
            this.events = events;
        }
    }

    static void offer(Session next) {
        cancel(null);
        pending = next;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (pending != next) return;
            pending = null;
            JSObject error = new JSObject();
            error.put("id", next.id);
            error.put("phase", "error");
            error.put("code", "start-timeout");
            error.put("message", "Le service de lecture Android ne démarre pas.");
            error.put("index", 0);
            next.events.accept(error);
        }, 5000);
    }

    static void discard(Session offered) {
        if (pending == offered) pending = null;
    }

    static void cancel(String id) {
        if (pending != null && (id == null || pending.id.equals(id))) pending = null;
        if (instance != null && instance.session != null
            && (id == null || instance.session.id.equals(id))) {
            instance.finish("cancelled", "cancelled", "Lecture interrompue.");
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            cancel(intent.getStringExtra("id"));
            if (!running) stopSelf(startId);
            return START_NOT_STICKY;
        }
        Session next = pending;
        if (next == null || intent == null || !next.id.equals(intent.getStringExtra("id"))) {
            if (!running) stopSelf(startId);
            return START_NOT_STICKY;
        }
        pending = null;
        instance = this;
        session = next;
        index = 0;
        running = true;
        try {
            NotificationManager notifications = getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Lecture vocale Sirius", NotificationManager.IMPORTANCE_LOW));
            mediaSession = new MediaSession(this, "SiriusVoice");
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override public void onStop() { cancel(null); }
                @Override public void onPause() { cancel(null); }
            });
            mediaSession.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, "Lecture vocale Sirius").build());
            mediaSession.setActive(true);
            startForeground(NOTIFICATION, notification());
            AudioAttributes attributes = attributes();
            audioManager = getSystemService(AudioManager.class);
            int focusResult;
            if (Build.VERSION.SDK_INT >= 26) {
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes).setOnAudioFocusChangeListener(focusListener, main).build();
                focusResult = audioManager.requestAudioFocus(focus);
            } else {
                focusResult = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN);
            }
            if (focusResult != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                throw new IllegalStateException("Audio focus unavailable");
            }
            wakeLock = getSystemService(PowerManager.class).newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":voice");
            wakeLock.acquire(TimeUnit.MINUTES.toMillis(30));
            workers = Executors.newFixedThreadPool(2);
            ExecutorService executor = workers;
            workers.execute(() -> readQueue(next, executor));
        } catch (RuntimeException error) {
            Log.e("SiriusPlayback", "Native playback start failed", error);
            finish("error", "start-failed", "Le lecteur Android ne peut pas démarrer.");
        }
        return START_NOT_STICKY;
    }

    private final Runnable prepareTimeout = () -> finish("error", "start-timeout",
        "Le lecteur Android ne démarre pas. Reprenez le bulletin.");

    private AudioAttributes attributes() {
        return new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    }

    private Notification notification() {
        Intent stop = new Intent(this, SiriusPlaybackService.class).setAction("stop")
            .putExtra("id", session.id);
        PendingIntent stopIntent = PendingIntent.getService(this, 0, stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_media_play).setContentTitle("Sirius")
            .setContentText("Lecture vocale en cours").setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause,
                "Arrêter", stopIntent).build())
            .setStyle(new Notification.MediaStyle().setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0));
        if (open != null) builder.setContentIntent(PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return builder.build();
    }

    private void event(String phase, String code, String message) {
        JSObject event = new JSObject();
        event.put("id", session.id);
        event.put("phase", phase);
        event.put("index", index);
        if (code != null) event.put("code", code);
        if (message != null) event.put("message", message);
        Log.i("SiriusPlayback", "phase=" + phase + " item=" + index
            + (code == null ? "" : " code=" + code));
        session.events.accept(event);
    }

    private void readQueue(Session owned, ExecutorService executor) {
        if (!running || session != owned) return;
        try {
            Future<File> next = executor.submit(() -> synthesize(owned, 0));
            for (int at = 0; at < owned.items.length() && running && session == owned; at++) {
                final int position = at;
                File audio = next.get();
                if (!running || session != owned) return;
                next = at + 1 < owned.items.length()
                    ? executor.submit(() -> synthesize(owned, position + 1)) : null;
                CountDownLatch ended = new CountDownLatch(1);
                AtomicReference<Exception> failure = new AtomicReference<>();
                main.post(() -> {
                    if (!running || session != owned) { ended.countDown(); return; }
                    index = position;
                    playbackDone = ended;
                    try {
                        if (wakeLock.isHeld()) wakeLock.release();
                        wakeLock.acquire(TimeUnit.MINUTES.toMillis(30));
                        if (audio == null) {
                            event("started", null, null);
                            event("ended", null, null);
                            ended.countDown();
                            return;
                        }
                        player = new MediaPlayer();
                        player.setAudioAttributes(attributes());
                        player.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK);
                        player.setDataSource(audio.getAbsolutePath());
                        float volume = (float) owned.items.getJSONObject(position).getDouble("volume");
                        player.setVolume(volume, volume);
                        player.setOnPreparedListener(prepared -> {
                            if (!running || player != prepared) return;
                            main.removeCallbacks(prepareTimeout);
                            try {
                                applyEqualizer(prepared, owned.equalizer);
                                prepared.start();
                            } catch (RuntimeException error) {
                                failure.set(error);
                                releasePlayer();
                                ended.countDown();
                                return;
                            }
                            mediaSession.setPlaybackState(new PlaybackState.Builder()
                                .setActions(PlaybackState.ACTION_STOP | PlaybackState.ACTION_PAUSE)
                                .setState(PlaybackState.STATE_PLAYING, 0, 1).build());
                            playbackProgress = new PlaybackProgress(SystemClock.elapsedRealtime());
                            main.postDelayed(progress, 1000);
                            event("started", null, null);
                        });
                        player.setOnCompletionListener(completed -> {
                            event("ended", null, null);
                            releasePlayer();
                            ended.countDown();
                        });
                        player.setOnErrorListener((failed, what, extra) -> {
                            failure.set(new IllegalStateException("Native audio playback failed"));
                            releasePlayer();
                            ended.countDown();
                            return true;
                        });
                        main.postDelayed(prepareTimeout, 10000);
                        player.prepareAsync();
                    } catch (Exception error) {
                        failure.set(error);
                        releasePlayer();
                        ended.countDown();
                    }
                });
                if (!ended.await(5, TimeUnit.MINUTES)) {
                    throw new IllegalStateException("Native audio preparation/playback timeout");
                }
                if (!running || session != owned) return;
                if (failure.get() != null) throw failure.get();
                deleteAudio(audio);
            }
            main.post(() -> { if (session == owned && running) finish("finished", null, null); });
        } catch (Exception error) {
            if (running && session == owned) {
                // Ne jamais journaliser les requêtes : elles contiennent texte et clés personnelles.
                Log.e("SiriusPlayback", "Native speech failed: " + error.getClass().getSimpleName());
                main.post(() -> {
                    if (session == owned && running) finish("error", "remote-playback",
                        "Lecture Gemini interrompue. Vérifiez la connexion puis reprenez le bulletin.");
                });
            }
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
        }
    }

    private File synthesize(Session owned, int at) throws Exception {
        if (!running || session != owned) throw new InterruptedException();
        JSONObject body = owned.items.getJSONObject(at).getJSONObject("body");
        if (body.getString("text").isEmpty()) return null;
        HttpURLConnection request = (HttpURLConnection) new URL(owned.endpoint).openConnection();
        owned.connection = request;
        File output = null;
        try {
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(28000);
            request.setReadTimeout(28000);
            request.setRequestMethod("POST");
            request.setDoOutput(true);
            request.setRequestProperty("Content-Type", "application/json");
            if (owned.cookie != null) request.setRequestProperty("Cookie", owned.cookie);
            if (owned.accessToken != null) {
                request.setRequestProperty("Authorization", "Bearer " + owned.accessToken);
            }
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            request.setFixedLengthStreamingMode(payload.length);
            try (java.io.OutputStream stream = request.getOutputStream()) { stream.write(payload); }
            if (request.getResponseCode() != 200) throw new IllegalStateException("Speech HTTP error");
            ByteArrayOutputStream response = new ByteArrayOutputStream();
            try (InputStream input = request.getInputStream()) {
                byte[] buffer = new byte[8192];
                int length;
                long until = SystemClock.elapsedRealtime() + 28000;
                while ((length = input.read(buffer)) != -1) {
                    if (!running || session != owned) throw new InterruptedException();
                    if (response.size() + length > MAX_RESPONSE_BYTES
                        || SystemClock.elapsedRealtime() > until) {
                        throw new IllegalStateException("Speech response exceeds limit");
                    }
                    response.write(buffer, 0, length);
                }
            }
            JSONObject data = new JSONObject(response.toString(StandardCharsets.UTF_8.name()));
            String encoded = data.optString("audio_base64");
            if (encoded.isEmpty()) encoded = data.optString("audio");
            if (encoded.isEmpty()) throw new IllegalStateException("Empty speech response");
            byte[] audio = Base64.decode(encoded, Base64.DEFAULT);
            if (audio.length == 0) throw new IllegalStateException("Empty decoded speech");
            synchronized (files) {
                if (!running || session != owned) throw new InterruptedException();
                output = File.createTempFile("sirius-playback-", ".audio", getCacheDir());
                files.add(output);
                try (FileOutputStream stream = new FileOutputStream(output)) { stream.write(audio); }
            }
            return output;
        } catch (Exception error) {
            deleteAudio(output);
            throw error;
        } finally {
            request.disconnect();
            if (owned.connection == request) owned.connection = null;
        }
    }

    private final Runnable progress = new Runnable() {
        @Override public void run() {
            if (!running || player == null) return;
            try {
                if (playbackProgress.stalled(player.getCurrentPosition(), SystemClock.elapsedRealtime())) {
                    finish("error", "playback-timeout", "Lecture audio Android bloquée. Reprenez le bulletin.");
                    return;
                }
            } catch (IllegalStateException error) {
                finish("error", "playback-state", "Le lecteur Android n'est plus disponible.");
                return;
            }
            main.postDelayed(this, 1000);
        }
    };

    private void releasePlayer() {
        main.removeCallbacks(progress);
        main.removeCallbacks(prepareTimeout);
        if (equalizer != null) { equalizer.release(); equalizer = null; }
        if (player != null) {
            player.setOnCompletionListener(null);
            player.setOnErrorListener(null);
            player.setOnPreparedListener(null);
            player.release();
            player = null;
        }
    }

    private void deleteAudio(File file) {
        if (file == null) return;
        synchronized (files) {
            if (file.exists() && !file.delete()) Log.w("SiriusPlayback", "Audio cache cleanup failed");
            files.remove(file);
        }
    }

    private void finish(String phase, String code, String message) {
        if (!running) return;
        running = false;
        event(phase, code, message);
        releasePlayer();
        if (playbackDone != null) playbackDone.countDown();
        if (workers != null) workers.shutdownNow();
        HttpURLConnection request = session.connection;
        if (request != null) new Thread(request::disconnect, "sirius-playback-stop").start();
        if (Build.VERSION.SDK_INT >= 26 && focus != null) audioManager.abandonAudioFocusRequest(focus);
        else if (audioManager != null) audioManager.abandonAudioFocus(focusListener);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (mediaSession != null) mediaSession.release();
        synchronized (files) {
            for (File file : new HashSet<>(files)) deleteAudio(file);
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() {
        finish("cancelled", "cancelled", "Lecteur Android arrêté.");
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        cancel(null);
        stopSelf();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        File[] stale = getCacheDir().listFiles((directory, name) ->
            name.startsWith("sirius-playback-") && name.endsWith(".audio"));
        if (stale == null) {
            Log.w("SiriusPlayback", "Unable to inspect previous audio cache");
            return;
        }
        for (File file : stale) deleteAudio(file);
    }

    private void applyEqualizer(MediaPlayer audio, JSObject config) {
        String[] keys = { "sub", "bass", "lowMid", "mid", "treble", "air" };
        double[] frequencies = { 80, 250, 500, 1200, 4000, 10000 };
        boolean adjusted = false;
        for (String key : keys) adjusted |= config.optDouble(key, 0) != 0;
        if (!adjusted) return;
        equalizer = new Equalizer(0, audio.getAudioSessionId());
        short[] range = equalizer.getBandLevelRange();
        for (short band = 0; band < equalizer.getNumberOfBands(); band++) {
            double frequency = equalizer.getCenterFreq(band) / 1000.0;
            int high = 0;
            while (high < frequencies.length - 1 && frequencies[high] < frequency) high++;
            int low = Math.max(0, high - 1);
            double mix = low == high ? 0 : Math.max(0, Math.min(1,
                Math.log(frequency / frequencies[low]) / Math.log(frequencies[high] / frequencies[low])));
            double gain = (1 - mix) * config.optDouble(keys[low], 0) + mix * config.optDouble(keys[high], 0);
            equalizer.setBandLevel(band, (short) Math.max(range[0], Math.min(range[1], gain * 100)));
        }
        equalizer.setEnabled(true);
    }
}
