package fr.sirius_assistant.app;

import android.content.Intent;
import android.webkit.CookieManager;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.URI;

@CapacitorPlugin(name = "SiriusPlayback")
public class SiriusPlaybackPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
                call.reject("Démarrez la lecture avec Sirius ouvert.", "BACKGROUND_START");
                return;
            }
            try {
                String id = call.getString("id");
                String endpoint = call.getString("endpoint");
                JSArray items = call.getArray("items");
                URI uri = new URI(endpoint);
                if (id == null || id.isEmpty() || !"https".equals(uri.getScheme())
                    || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getQuery() != null || uri.getFragment() != null
                    || !uri.getPath().matches(".*/api/tts/(gemini|google)")
                    || items == null || items.length() == 0) {
                    call.reject("Paramètres de lecture Android invalides.", "INVALID_INPUT");
                    return;
                }
                for (int i = 0; i < items.length(); i++) {
                    String text = items.getJSONObject(i).getJSONObject("body").getString("text");
                    double volume = items.getJSONObject(i).getDouble("volume");
                    if (text.length() > 10000 || !Double.isFinite(volume) || volume < 0.2 || volume > 1) {
                        call.reject("Phrase ou volume de lecture invalide.", "INVALID_INPUT");
                        return;
                    }
                }
                SiriusPlaybackService.Session session = new SiriusPlaybackService.Session(
                    id, endpoint, CookieManager.getInstance().getCookie(endpoint),
                    call.getString("accessToken"), items, call.getObject("equalizer", new JSObject()),
                    event -> notifyListeners("playback", event));
                SiriusPlaybackService.offer(session);
                try {
                    ContextCompat.startForegroundService(getContext(), new Intent(
                        getContext(), SiriusPlaybackService.class).putExtra("id", id));
                } catch (RuntimeException error) {
                    SiriusPlaybackService.discard(session);
                    throw error;
                }
                call.resolve();
            } catch (Exception error) {
                call.reject("Impossible de démarrer le lecteur Android.", "START_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            SiriusPlaybackService.cancel(call.getString("id"));
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        SiriusPlaybackService.cancel(null);
    }
}
