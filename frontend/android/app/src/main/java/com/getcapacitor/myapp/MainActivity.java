package fr.sirius_assistant.app;

import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private int lastPermissionRequestCode = Integer.MIN_VALUE;
	private long lastPermissionResultAt;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(SiriusSpeechPlugin.class);
		registerPlugin(SiriusAudioPlugin.class);
		registerPlugin(SiriusPlaybackPlugin.class);
		registerPlugin(SiriusHaccpPrinterPlugin.class);
		super.onCreate(savedInstanceState);
		getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
	}

	@Override
	public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
		long now = SystemClock.uptimeMillis();
		boolean duplicate = requestCode == lastPermissionRequestCode
			&& now - lastPermissionResultAt < 1000
			&& permissions != null
			&& permissions.length > 0
			&& grantResults != null
			&& grantResults.length == permissions.length;
		if (duplicate) return;
		lastPermissionRequestCode = requestCode;
		lastPermissionResultAt = now;
		super.onRequestPermissionsResult(requestCode, permissions, grantResults);
	}
}
