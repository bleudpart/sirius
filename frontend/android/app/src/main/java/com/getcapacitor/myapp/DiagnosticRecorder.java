package fr.sirius_assistant.app;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Capture comparative de diagnostic, pure Java, strictement bornée et sur consentement explicite.
 * Enregistre le PCM brut des seules périodes d'écoute (non suspendues) dans des WAV privés, ainsi que
 * les segments produits par {@link UtteranceSegmenter} pendant ces périodes, pour comparer hors ligne.
 * Aucune donnée audio n'est journalisée ; seules des métadonnées sont exposées. Thread-safe.
 */
public final class DiagnosticRecorder {
    public static final String DIR_NAME = "sirius-audio-diagnostics";
    public static final String MANIFEST = "manifest.json";
    public static final int SAMPLE_RATE = UtteranceSegmenter.SAMPLE_RATE;
    public static final int DEFAULT_MAX_SAMPLE_SAMPLES = 20 * SAMPLE_RATE;
    public static final int DEFAULT_MAX_SESSION_SAMPLES = 60 * SAMPLE_RATE;
    public static final int DEFAULT_MAX_SAMPLES = 3;
    public static final int DEFAULT_MAX_SEGMENTS_PER_SAMPLE = 3;

    public static final class SegmentInfo {
        public final String file;
        public final int sampleCount;
        public final int preRollSamples;
        public final long speechStartMs;
        public final long endedMs;
        public final String reason;
        /** Position du premier échantillon du segment dans le WAV brut (peut être négative ou dépasser la fin). */
        public final long offsetSamples;

        SegmentInfo(String file, UtteranceSegmenter.Event event, long offsetSamples) {
            this.file = file;
            this.sampleCount = event.sampleCount;
            this.preRollSamples = event.preRollSamples;
            this.speechStartMs = event.speechStartMs;
            this.endedMs = event.endedMs;
            this.reason = event.reason;
            this.offsetSamples = offsetSamples;
        }
    }

    public static final class SampleInfo {
        public final int id;
        public final String file;
        public final long epoch;
        /** Index d'échantillon de session (horloge d'échantillons) du premier échantillon brut. */
        public final long startSample;
        public int sampleCount;
        /** null tant que l'échantillon est ouvert ; sinon suppressed|limit|budget|stopped|error. */
        public String endReason;
        public final List<SegmentInfo> segments = new ArrayList<>();

        SampleInfo(int id, String file, long epoch, long startSample) {
            this.id = id;
            this.file = file;
            this.epoch = epoch;
            this.startSample = startSample;
        }

        SampleInfo copy() {
            SampleInfo copy = new SampleInfo(id, file, epoch, startSample);
            copy.sampleCount = sampleCount;
            copy.endReason = endReason;
            copy.segments.addAll(segments);
            return copy;
        }
    }

    public static final class FileInfo {
        public final String name;
        public final long bytes;

        FileInfo(String name, long bytes) {
            this.name = name;
            this.bytes = bytes;
        }
    }

    private final File dir;
    private final int maxSampleSamples;
    private final int maxSessionSamples;
    private final int maxSamples;
    private final int maxSegmentsPerSample;

    private final List<SampleInfo> samples = new ArrayList<>();
    private final byte[] scratch = new byte[UtteranceSegmenter.FRAME_SAMPLES * 2];
    private boolean enabled;
    private boolean closed;
    private String error;
    private String pendingFailure;
    private SampleInfo current;
    private File currentFile;
    private OutputStream out;
    private long exhaustedEpoch = Long.MIN_VALUE;
    private int sessionSamples;

    public DiagnosticRecorder(File dir) {
        this(dir, DEFAULT_MAX_SAMPLE_SAMPLES, DEFAULT_MAX_SESSION_SAMPLES, DEFAULT_MAX_SAMPLES,
            DEFAULT_MAX_SEGMENTS_PER_SAMPLE);
    }

    public DiagnosticRecorder(File dir, int maxSampleSamples, int maxSessionSamples, int maxSamples,
                              int maxSegmentsPerSample) {
        this.dir = dir;
        this.maxSampleSamples = maxSampleSamples;
        this.maxSessionSamples = maxSessionSamples;
        this.maxSamples = maxSamples;
        this.maxSegmentsPerSample = maxSegmentsPerSample;
    }

    /** Nouveau consentement : efface les fichiers précédents puis active la capture (sans effet si déjà close). */
    public synchronized void open() {
        if (closed || enabled) return;
        deleteDirectory(dir);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            fail("création du dossier impossible");
            return;
        }
        enabled = true;
        writeManifest();
    }

    public synchronized boolean isCapturing() { return enabled; }

    public synchronized String error() { return error; }

    /** Message d'échec d'écriture non encore signalé (une seule fois), ou null. Ne contient jamais d'audio. */
    public synchronized String consumeFailure() {
        String failure = pendingFailure;
        pendingFailure = null;
        return failure;
    }

    /**
     * Trame lue par la session. {@code listening} et {@code epoch} doivent être lus atomiquement avec le
     * traitement de la trame par le segmenteur. Les trames suspendues (lecture TTS) ne sont jamais écrites.
     */
    public synchronized void onFrame(short[] frame, boolean listening, long epoch, long sessionSampleIndex) {
        if (!enabled) return;
        if (!listening) {
            closeCurrent("suppressed");
            return;
        }
        if (current != null && current.epoch != epoch) closeCurrent("suppressed");
        if (current == null) {
            if (epoch == exhaustedEpoch || samples.size() >= maxSamples || sessionSamples >= maxSessionSamples) return;
            if (!begin(epoch, sessionSampleIndex)) return;
        }
        int room = Math.min(maxSampleSamples - current.sampleCount, maxSessionSamples - sessionSamples);
        int count = Math.min(room, frame.length);
        for (int i = 0; i < count; i++) {
            scratch[i * 2] = (byte) frame[i];
            scratch[i * 2 + 1] = (byte) (frame[i] >> 8);
        }
        try {
            out.write(scratch, 0, count * 2);
        } catch (IOException failure) {
            fail("écriture de l'échantillon brut impossible", failure);
            return;
        }
        current.sampleCount += count;
        sessionSamples += count;
        if (current.sampleCount >= maxSampleSamples) closeCurrent("limit");
        else if (sessionSamples >= maxSessionSamples) closeCurrent("budget");
    }

    /** Segment émis par le segmenteur ; rattaché à l'échantillon brut de la même génération d'écoute. */
    public synchronized void onSegment(UtteranceSegmenter.Event event) {
        if (!enabled || event == null || event.type != UtteranceSegmenter.Type.UTTERANCE || event.pcm == null) return;
        SampleInfo owner = null;
        for (int i = samples.size() - 1; i >= 0; i--) {
            if (samples.get(i).epoch == event.epoch) {
                owner = samples.get(i);
                break;
            }
        }
        if (owner == null || owner.segments.size() >= maxSegmentsPerSample) return;
        String name = "sample-" + owner.id + "-segment-" + (owner.segments.size() + 1) + ".wav";
        long segmentStart = event.speechStartMs * SAMPLE_RATE / 1000 - event.preRollSamples;
        try (OutputStream segment = new BufferedOutputStream(new FileOutputStream(new File(dir, name)))) {
            segment.write(UtteranceSegmenter.toWav(event.pcm, SAMPLE_RATE));
        } catch (IOException failure) {
            fail("écriture du segment impossible", failure);
            return;
        }
        owner.segments.add(new SegmentInfo(name, event, segmentStart - owner.startSample));
        writeManifest();
    }

    /** Fin de session : finalise l'échantillon ouvert et refuse toute capture ultérieure. */
    public synchronized void finish(String reason) {
        closeCurrent(reason);
        enabled = false;
        closed = true;
    }

    /** Suppression explicite : arrête la capture de cette session et efface tous les fichiers. */
    public synchronized int deleteAll() {
        closeQuietly();
        current = null;
        enabled = false;
        closed = true;
        samples.clear();
        return deleteDirectory(dir);
    }

    public synchronized List<SampleInfo> snapshot() {
        List<SampleInfo> copy = new ArrayList<>();
        for (SampleInfo sample : samples) copy.add(sample.copy());
        return copy;
    }

    public static List<FileInfo> listFiles(File dir) {
        List<FileInfo> files = new ArrayList<>();
        File[] entries = dir.listFiles();
        if (entries == null) return files;
        for (File entry : entries) if (entry.isFile()) files.add(new FileInfo(entry.getName(), entry.length()));
        files.sort((a, b) -> a.name.compareTo(b.name));
        return files;
    }

    public static int deleteDirectory(File dir) {
        int deleted = 0;
        File[] entries = dir.listFiles();
        if (entries != null) {
            for (File entry : entries) if (entry.isFile() && entry.delete()) deleted++;
        }
        dir.delete();
        return deleted;
    }

    private boolean begin(long epoch, long startSample) {
        int id = samples.size() + 1;
        String name = "sample-" + id + "-raw.wav";
        File file = new File(dir, name);
        try {
            out = new BufferedOutputStream(new FileOutputStream(file), 16 * 1024);
            out.write(UtteranceSegmenter.toWav(new short[0], SAMPLE_RATE));
        } catch (IOException failure) {
            fail("création de l'échantillon brut impossible", failure);
            return false;
        }
        currentFile = file;
        current = new SampleInfo(id, name, epoch, startSample);
        samples.add(current);
        return true;
    }

    private void closeCurrent(String reason) {
        if (current == null) return;
        SampleInfo closing = current;
        File file = currentFile;
        current = null;
        currentFile = null;
        closing.endReason = reason;
        exhaustedEpoch = closing.epoch;
        try {
            out.close();
            out = null;
            patchHeader(file, closing.sampleCount * 2);
        } catch (IOException failure) {
            closing.endReason = "error";
            fail("finalisation de l'échantillon brut impossible", failure);
            return;
        }
        writeManifest();
    }

    private static void patchHeader(File file, int dataBytes) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            raf.seek(4);
            raf.write(littleEndian(36 + dataBytes));
            raf.seek(40);
            raf.write(littleEndian(dataBytes));
        }
    }

    private static byte[] littleEndian(int value) {
        return new byte[] { (byte) value, (byte) (value >> 8), (byte) (value >> 16), (byte) (value >> 24) };
    }

    private void fail(String what, IOException failure) {
        fail(what + (failure.getMessage() != null ? " (" + failure.getMessage() + ")" : ""));
    }

    private void fail(String what) {
        error = "io";
        if (pendingFailure == null) pendingFailure = "Capture de diagnostic arrêtée : " + what + ".";
        enabled = false;
        closeQuietly();
        if (current != null) {
            current.endReason = "error";
            current = null;
        }
    }

    private void closeQuietly() {
        if (out == null) return;
        try {
            out.close();
        } catch (IOException ignored) {
            // Fichier partiel : signalé par endReason/error, sans journalisation.
        }
        out = null;
    }

    private void writeManifest() {
        StringBuilder json = new StringBuilder("{\"sampleRate\":").append(SAMPLE_RATE).append(",\"samples\":[");
        for (int i = 0; i < samples.size(); i++) {
            SampleInfo s = samples.get(i);
            if (i > 0) json.append(',');
            json.append("{\"id\":").append(s.id)
                .append(",\"file\":\"").append(s.file).append('"')
                .append(",\"startSample\":").append(s.startSample)
                .append(",\"sampleCount\":").append(s.sampleCount)
                .append(",\"endReason\":").append(s.endReason == null ? "null" : "\"" + s.endReason + "\"")
                .append(",\"segments\":[");
            for (int j = 0; j < s.segments.size(); j++) {
                SegmentInfo g = s.segments.get(j);
                if (j > 0) json.append(',');
                json.append("{\"file\":\"").append(g.file).append('"')
                    .append(",\"sampleCount\":").append(g.sampleCount)
                    .append(",\"preRollSamples\":").append(g.preRollSamples)
                    .append(",\"speechStartMs\":").append(g.speechStartMs)
                    .append(",\"endedMs\":").append(g.endedMs)
                    .append(",\"reason\":\"").append(g.reason).append('"')
                    .append(",\"offsetSamples\":").append(g.offsetSamples).append('}');
            }
            json.append("]}");
        }
        json.append("]}");
        try (OutputStream manifest = new FileOutputStream(new File(dir, MANIFEST))) {
            manifest.write(json.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException failure) {
            error = "io";
            if (pendingFailure == null) {
                pendingFailure = "Manifeste de diagnostic non écrit ; la capture continue.";
            }
        }
    }
}
