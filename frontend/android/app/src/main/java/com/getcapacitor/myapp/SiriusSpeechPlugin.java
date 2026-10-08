package fr.sirius_assistant.app;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

@CapacitorPlugin(name = "SiriusSpeech", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class SiriusSpeechPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private PluginCall pending;
    private Runnable deadline;
    private int generation;

    @PluginMethod
    public void available(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("available", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext()));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            cancelPending();
            pending = call;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                requestPermissionForAlias("microphone", call, "microphonePermission");
                return;
            }
            startGranted(call);
        });
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        if (pending != call) return;
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            pending = null;
            call.reject("Microphone non autorisé.", "PERMISSION_DENIED");
            return;
        }
        startGranted(call);
    }

    private void startGranted(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != call) return;
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                pending = null;
                call.reject("Reconnaissance locale Android indisponible.", "UNAVAILABLE");
                return;
            }
            int current = ++generation;
            try {
                recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(new RecognitionListener() {
                    private boolean isCurrent() { return current == generation && pending == call; }
                    private void event(String phase, String text) {
                        if (!isCurrent()) return;
                        JSObject result = new JSObject();
                        result.put("id", call.getString("id"));
                        result.put("phase", phase);
                        result.put("text", text);
                        notifyListeners("recognition", result);
                    }
                    @Override public void onReadyForSpeech(Bundle params) { event("listening", ""); }
                    @Override public void onBeginningOfSpeech() {}
                    @Override public void onRmsChanged(float rmsdB) {}
                    @Override public void onBufferReceived(byte[] buffer) {}
                    @Override public void onEndOfSpeech() { event("transcribing", ""); }
                    @Override public void onEvent(int eventType, Bundle params) {}
                    @Override public void onPartialResults(Bundle results) {
                        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        event("partial", texts != null && !texts.isEmpty() ? texts.get(0) : "");
                    }
                    @Override public void onResults(Bundle results) {
                        if (!isCurrent()) return;
                        ArrayList<String> texts = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        JSObject result = new JSObject();
                        result.put("text", texts != null && !texts.isEmpty() ? texts.get(0) : "");
                        pending = null;
                        release();
                        call.resolve(result);
                    }
                    @Override public void onError(int error) {
                        if (!isCurrent()) return;
                        String code = error == SpeechRecognizer.ERROR_NO_MATCH
                            || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "NO_SPEECH"
                            : error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "PERMISSION_DENIED"
                            : error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? "BUSY" : "UNAVAILABLE";
                        pending = null;
                        release();
                        call.reject("Reconnaissance Android interrompue (code " + error + ").", code);
                    }
                });
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fr-FR");
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                deadline = () -> {
                    if (current != generation || pending != call) return;
                    pending = null;
                    release();
                    call.reject("Délai de reconnaissance locale dépassé.", "UNAVAILABLE");
                };
                handler.postDelayed(deadline, 20000);
                recognizer.startListening(intent);
            } catch (RuntimeException error) {
                pending = null;
                release();
                call.reject("Impossible de démarrer la reconnaissance locale.", "UNAVAILABLE", error);
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            cancelPending();
            call.resolve();
        });
    }

    private void cancelPending() {
        PluginCall previous = pending;
        pending = null;
        generation++;
        release();
        if (previous != null) previous.reject("Reconnaissance annulée.", "CANCELLED");
    }

    private void release() {
        if (deadline != null) handler.removeCallbacks(deadline);
        deadline = null;
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
    }

    @Override
    protected void handleOnPause() {
        getActivity().runOnUiThread(this::cancelPending);
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(this::cancelPending);
    }
}
