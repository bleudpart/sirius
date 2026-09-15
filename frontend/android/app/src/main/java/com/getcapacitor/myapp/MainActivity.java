package sh.techenclair.sirius;

import android.content.pm.PackageManager;
import android.os.SystemClock;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private int lastPermissionRequestCode = Integer.MIN_VALUE;
	private long lastPermissionResultAt;

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
