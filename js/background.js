/*
    Listening for alerts.
*/

var currentCities = [];
var activeFlashMessages = []
var currentAlertCities = []; // All cities of this alert (For alert message)
var interval;
var pollingAlertsBackup = false;

const WEBSOCKET_URL = "wss://ws.tzevaadom.co.il/socket?platform=CHROME_EXT";
const NOTIFICATIONS_API_URL = "https://api.tzevaadom.co.il/notifications";
const LISTS_VERSIONS_URL = "https://api.tzevaadom.co.il/lists-versions";

window.addEventListener("load", async (_) => {
  try {
    await City.loadingDataPromise;
  } catch {}
  await fetchAndCheckLists().catch(() => null);
  WSConnection();
});

async function checkListsVersion({ polygons, cities }) {
  await Promise.allSettled([
    Preferences.setPolygonsVersion(polygons),
    Preferences.setCitiesVersion(cities),
  ]);
  await City.loadData();
}

async function fetchAndCheckLists() {
  const data = await fetch(LISTS_VERSIONS_URL).then(async (r) => r.json());
  if (data.polygons && data.cities) await checkListsVersion(data);
}

//24h check lists
setInterval(() => fetchAndCheckLists(), 24 * 60 * 60 * 1000);

function poolAlertsBackup() {
  if (!pollingAlertsBackup) return;

  setTimeout(poolAlertsBackup, 3000);
}

// -1 error both
// 0 websocket
// 1 api notifications
let connectionStatus = 0;

let runBackupAPI = false;

async function backupAPI() {
  if (!runBackupAPI) return;
  const result = await fetch(NOTIFICATIONS_API_URL)
    .then((r) => r.json())
    .catch(() => {
      if (!runBackupAPI) return;

      connectionStatus = -1;
      return null;
    });

  if (!runBackupAPI) return;

  if (result != null) {
    result.forEach((r) => getAlerts(r, "notificationsAPI"));
    connectionStatus = 1;
  }

  setTimeout(backupAPI, 3000);
}

function WSConnection() {
  /*
        WS connection
    */

  var ws = new WebSocket(WEBSOCKET_URL);

  //10 minutes of inactivity
  const REOPEN_IF_INACTIVE_FOR = 10 * 60 * 1000;
  const RECONNECT_INTERVAL = 5_000;

  let inactivityTimeoutId;
  const logActivity = () => {
    if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId);
    inactivityTimeoutId = setTimeout(() => handleReconnect("inactivity"), REOPEN_IF_INACTIVE_FOR);
  };

  ws.onmessage = (m) => {
    logActivity();
    if (typeof m.data != "string") return;
    const { type, data } = JSON.parse(m.data);
    switch (type) {
      case "ALERT":
        getAlerts(data, "websocket");
        break;
      case "LISTS_VERSIONS":
        checkListsVersion(data);
        break;
      case "SYSTEM_MESSAGE":
        handleSystemMessage(data);
        break;
    }
  };

  logActivity();

  let isReconnecting = false;
  const handleReconnect = (reason) => {
    console.warn("restarting websocket due to", reason);

    if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId);
    ws.close();
    if (isReconnecting) return;
    isReconnecting = true;
    // console.log("ws reconnecting");

    if (!runBackupAPI) {
      runBackupAPI = true;
      backupAPI();
    }

    setTimeout(WSConnection, RECONNECT_INTERVAL);
  };

  ws.onopen = (e) => {
    console.log("ws connected");
    connectionStatus = 0;
    runBackupAPI = false;
  };

  ws.onclose = (e) => {
    //console.log("ws closed");
    handleReconnect(e);
  };
  ws.onerror = (e) => {
    //console.log("ws errored");
    handleReconnect(e);
  };
}

var rcvNotificationIds = [];

async function getAlerts(alert, source, testAlert = false) {
  if (!alert.notificationId) alert.notificationId = String(Math.random());
  if (!alert.isDrill) alert.isDrill = false;
  if (typeof alert.threat == "undefined") alert.threat = 8;

  if (rcvNotificationIds.includes(alert.notificationId)) return;
  rcvNotificationIds.push(alert.notificationId);
  if (rcvNotificationIds.length > 100) rcvNotificationIds.shift();

  if (source != "test") console.log("alert from", source, alert);
  /*
        Handler - New alert received!
    */
  const [
    selectionCitiesIDs,
    selectionAreasIDs,
    selectedThreats,
    selectedDrillsAlert,
    silentNotSelected,
  ] = await Promise.all([
    Preferences.getSelectedCities(),
    Preferences.getSelectedAreas(),
    Preferences.getSelectedThreats(),
    Preferences.getSelectedDrillsAlerts(),
    Preferences.getSilentNotSelected(),
  ]);

  //save for popup - open alert btn
  localStorage.setItem("lastAlertServerTime", alert["time"]);

  // Get alert cities & filter by cities selection

  // 10 march 2023 - dont use server time, use local time since this can cause issues when system time is not calibrated
  var alertCities = alert["cities"].map(
    (cityValue) =>
      new City(cityValue, alert["threat"], alert["isDrill"], Math.floor(Date.now() / 1000))
  );

  const selectAll = selectionCitiesIDs.length == 0 && selectionAreasIDs.length == 0;

  alertCities = alertCities.filter((city) => {
    //filter threats
    if (
      selectedThreats.length != 0 &&
      !selectedThreats.includes(city.threat) &&
      city.threat != DRILLS_THREAT_ID
    )
      return false;

    //filter drills
    if ((city.isDrill || city.threat == DRILLS_THREAT_ID) && !selectedDrillsAlert) return false;

    //filter cities
    return (
      silentNotSelected ||
      selectionCitiesIDs.includes(city.id) ||
      selectionAreasIDs.includes(city.areaID) ||
      selectAll ||
      testAlert ||
      City.virtualCitiesIds.includes(city.id)
    );
  });

  if (alertCities.length == 0) return;
  const anyContainsSelection = alertCities.some(
    (c) =>
      selectionCitiesIDs.includes(c.id) ||
      selectionAreasIDs.includes(c.areaID) ||
      City.virtualCitiesIds.includes(c.id)
  );

  // Show notify & play sound
  if (!(silentNotSelected && !anyContainsSelection) || selectAll)
    Preferences.playSound(
      alertCities
        .map((city) => city.id)
        .filter((cityID) => cityID != -1)
        .sort((a, b) => a - b),
      alert.threat,
      alert.isDrill
    );

  // To show all the cities
  currentCities = currentCities.concat(alertCities);
  currentAlertCities = currentAlertCities.concat(alertCities);

  // Update data and refresh after countdown finish.
  // isPriorityAlert: alert matched a specifically selected area/city — overrides focus cooldown
  const isPriorityAlert = anyContainsSelection;
  updateData(true, alertCities, silentNotSelected && !anyContainsSelection, isPriorityAlert);
}

var flashPopupCreatingPromise;
async function handleSystemMessage(data){
  console.log("handleSystemMessage", data)
  if (!data.instruction) return;

  let citiesIds = data?.citiesIds || [];
  if (!data.citiesIds?.length) {
      const allCities = await City.getAllCities();
      data.areasIds?.forEach(aId => {
          const citiesInArea = allCities.filter(c => c.areaID == aId);
          citiesInArea.forEach(({id}) => {
              citiesIds.push(id);
          });
      });
  }

   const [
    selectionCitiesIDs,
    selectionAreasIDs,
    selectedFlashSound,
    silentNotSelected,
  ] = await Promise.all([
    Preferences.getSelectedCities(),
    Preferences.getSelectedAreas(),
    Preferences.getSelectedFlashSound(),
    Preferences.getSilentNotSelected(),
  ]);


  let playSound = true
  if (!citiesIds.some(c => selectionCitiesIDs.includes(c) || City.virtualCitiesIds.includes(c)) &&
   !data?.areasIds.some(c => selectionAreasIDs.includes(c)) &&
   !(selectionCitiesIDs.length == 0 && selectionAreasIDs.length == 0)
  ){
    if (!silentNotSelected){
       return console.log("rcv sysmessage not relevant")
    }
    playSound = false
  }

  const lang = await Preferences.getSelectedLanguage();
  let title = "";
  let body = "";
  switch (lang) {
    case "EN":
      title = data.titleEn
      body = data.bodyEn
      break
    case "RU":
      title = data.titleRu
      body = data.bodyRu
      break
    case "AR":
      title = data.titleAr
      body = data.bodyAr
      break
    case "ES":
      title = data.titleEn
      body = data.bodyEs
      break
    default:
      title = data.titleHe
      body = data.bodyHe
      break;
  }

  const flashMessage = {citiesIds, title, body, expireAt: Date.now() + 180_000, ts: Date.now()}
  activeFlashMessages.push(flashMessage)

  const soundType =
      selectedFlashSound == "bell" || selectedFlashSound == "tone" || selectedFlashSound == "redalert3" ? "mp3" : "wav";
  
  if (playSound && selectedFlashSound && selectedFlashSound != "silent")
      new Audio(`../sounds/${selectedFlashSound}.${soundType}`).play()

  const desktop = await Preferences.getSelectedDesktop();
  if (!desktop){
    if (flashPopupCreatingPromise) await flashPopupCreatingPromise;
    else{
      popupCreatingPromise = flashPopup(false, playSound);
      await flashPopupCreatingPromise;
      popupCreatingPromise = null;
    }
    if (flasshPopupWindow) {
      chrome.runtime.sendMessage({ flash: flashMessage });
    }
    return
  }
    // Desktop
    var options = {
      type: "basic",
      title,
      message: body,
      iconUrl: "../img/notify.png",
      buttons: [],
    };
    chrome.notifications.create(options);

}

var lastData = [];
var popupCreatingPromise;
async function updateData(isNewData, alertCities, forcePreventFoucus = false, isPriorityAlert = false) {
  // Filter list by countdown & alert's timestamp
  currentCities = currentCities.filter((city) => {
    return city.getCountdown() > 0;
  });
  if (currentCities.length == 0) return finishAlert();

  // Refresh data every 1 sec (To remove when countdown finish)
  if (interval == null)
    interval = setInterval(() => {
      updateData(false, []);
    }, 1000);

  // If data was changed, update in popup.
  if (!equalArrays(currentCities, lastData)) {
    // If is not new data, dont open the alert window again
    if (isNewData) {
      // Check what type of notification we need to create
      const desktop = await Preferences.getSelectedDesktop();
      if (desktop && alertCities.length) {
        // To show only the newest
        notify(alertCities);
      } else {
        if (popupCreatingPromise) await popupCreatingPromise;
        else {
          popupCreatingPromise = popup(forcePreventFoucus, isPriorityAlert);
          await popupCreatingPromise;
          popupCreatingPromise = null;
        }
      }
    }

    if (popupCreatingPromise) await popupCreatingPromise;
    if (popupWindow) chrome.runtime.sendMessage({ cities: this.currentCities });
  }

  lastData = currentCities;
}

function finishAlert() {
  /*
        Alert ended
    */
  // Clear all data
  currentCities = [];
  currentAlertCities = [];
  lastData = [];
  if (interval != null) {
    clearInterval(interval);
    interval = null;
  }

  // Close popup window
  if (popupWindow) chrome.runtime.sendMessage({ cities: this.currentCities });
}

function equalArrays(one, two) {
  if ((one.length == 0 && two.length == 0) || one.length != two.length) return false;
  var same = true;
  one.forEach((a, i) => {
    if (a != two[i]) same = false;
  });
  return same;
}

async function notify(cities) {
  /*
        Show notification
    */
  const siteLanguage = await Preferences.getSelectedLanguage();
  City.siteLanguage = siteLanguage;

  // Sort list by Threats & Areas
  var newList = Preferences.sortCitiesByThreatDrillKey(cities);
  Object.keys(newList).forEach((threatDrillKey) => {
    var areasNames = [];
    var citiesNames = [];

    const [threat, isDrill] = City.decodeThreatDrillKey(threatDrillKey);

    Object.keys(newList[threatDrillKey]).forEach((areaName) => {
      areasNames.push(areaName);
      citiesNames = citiesNames.concat(newList[threatDrillKey][areaName]);
    });

    const title =
      City.getLocalizationThreatDrillTitle(threat, isDrill) + ": " + areasNames.join(", ");
    const message = citiesNames.join(", ");

    // Desktop
    var options = {
      type: "basic",
      title,
      message,
      iconUrl: "../img/notify.png",
      buttons: [
        { title: STRINGS.openMapButton[siteLanguage.toLowerCase()] || STRINGS.openMapButton.he },
        { title: STRINGS.copyButton[siteLanguage.toLowerCase()] || STRINGS.copyButton.he },
      ],
    };

    chrome.notifications.create(options);
  });
}

function desktopNotificationClicked(notifId, btnIdx) {
  console.log("Notification clicked");
  if (!btnIdx) return Preferences.launchSiteMap(this.currentAlertCities);
  Preferences.copyAlert(this.currentAlertCities);
}

var popupWindow;
var isPopupCreating = false;
const lastPopupFocusTimes = {}; // keyed by popup type: "alert", "flash"
const POPUP_FOCUS_COOLDOWN_MS = 60_000;

async function popup(forcePreventFoucus = false, isPriorityAlert = false) {

  if (isPopupCreating) return;
  isPopupCreating = true;

  var options = {
    url: "../alert.html",
    type: "popup",
    width: 700,
    height: 270,
    left: 0,
    top: window.screen.height - 270,
  };

  try {
    const [preventfocus, preventFrequentFocus] = await Promise.all([
      Preferences.getSelectedBackgroundHidePopup(),
      Preferences.getPreventFrequentPopupFocus(),
    ]);

    const now = Date.now();
    const popupLastFocusAt = lastPopupFocusTimes["alert"] ?? 0;
    const canFocusAgain =
        now - popupLastFocusAt > POPUP_FOCUS_COOLDOWN_MS ||
        !preventFrequentFocus;
    const shouldFocus = !forcePreventFoucus && !preventfocus && canFocusAgain;

    if (shouldFocus) {
        options.focused = true;
        lastPopupFocusTimes["alert"] = now;
    }

    if (!popupWindow) {
      popupWindow = await new Promise((resolve, reject) =>
        chrome.windows.create(options, (window) => resolve(window))
      );
    } else {
      popupWindow = await new Promise((resolve, reject) =>
        chrome.windows.update(
          popupWindow.id,
          (shouldFocus ? { focused: true } : {}),
          (window) =>
            !window
              ? chrome.windows.create(options, (window) => resolve(window))
              : resolve(popupWindow)
        )
      );
    }
  } catch (error) {}
  isPopupCreating = false;
}

var flasshPopupWindow;
var isFlashPopupCreating = false;
async function flashPopup(forcePreventFoucus = false, isPriorityAlert = false) {
  if (isFlashPopupCreating) return;
  isFlashPopupCreating = true;

  var options = {
    url: "../flash.html",
    type: "popup",
    width: 700,
    height: 270,
    left: 0,
    top: window.screen.height - 270,
  };

  try {
    const [preventfocus, preventFrequentFocus] = await Promise.all([
      Preferences.getSelectedBackgroundHidePopup(),
      Preferences.getPreventFrequentPopupFocus(),
    ]);

    const now = Date.now();
    const flashPopupLastFocusAt = lastPopupFocusTimes["flash"] ?? 0;
    const canFocusAgain =
        now - flashPopupLastFocusAt > POPUP_FOCUS_COOLDOWN_MS ||
        !preventFrequentFocus;
    const shouldFocus = !forcePreventFoucus && !preventfocus && canFocusAgain;

    if (shouldFocus) {
        options.focused = true;
        lastPopupFocusTimes["flash"] = now;
    }

    if (!flasshPopupWindow) {
      flasshPopupWindow = await new Promise((resolve, reject) =>
        chrome.windows.create(options, (window) => resolve(window))
      );
    } else {
      flasshPopupWindow = await new Promise((resolve, reject) =>
        chrome.windows.update(
          flasshPopupWindow.id,
          (shouldFocus ? { focused: true } : {}),
          (window) =>
            !window
              ? chrome.windows.create(options, (window) => resolve(window))
              : resolve(flasshPopupWindow)
        )
      );
    }
  } catch (error) {}
  isFlashPopupCreating = false;
}


let testThreat = 0;
const getTestThreat = (selectedThreats) => {
  if (selectedThreats.length == 0) {
    if (testThreat == 8) {
      testThreat = 0;
      return 8;
    }

    testThreat++;
    return testThreat - 1;
  }

  const idx = selectedThreats.indexOf(testThreat);
  if (idx == -1 || idx == selectedThreats.length - 1) {
    testThreat = selectedThreats[0];
    return testThreat;
  }

  testThreat = selectedThreats[idx + 1];
  return testThreat;
};

// Return current cities
chrome.runtime.onMessage.addListener(async (value, sender, sendResponse) => {
  switch (value) {
    case "currentCities":
      return sendResponse(this.currentCities);

    case "activeFlashMessages":
      return sendResponse(activeFlashMessages);

    case "currentAlertCities":
      return sendResponse(this.currentAlertCities);

    case "testAlert":
      return getAlerts(
        {
          cities: ["בדיקה"],
          threat: getTestThreat(await Preferences.getSelectedThreats()),
          time: Math.floor(Date.now() / 1000),
          isDrill: false,
        },
        "test",
        true
      );

    case "isConnectedToServer":
      return sendResponse(connectionStatus != -1);
  }

  if (typeof value != "object") return;

  const { type, data } = value;
  switch (type) {
    case "NOTIFICATION_CLICKED":
      return desktopNotificationClicked(...data);
  }
});


//general clean loop
setInterval(() => {
  //clean this to not have a long message
  currentAlertCities = currentAlertCities.filter(
    (c) => Date.now() - c.timestamp * 1000 < 3 * 60 * 1000
  );

  
  //clean flash alerts
  const now = Date.now()
  for (let i = activeFlashMessages.length - 1; i >= 0; i--) {
    if (activeFlashMessages[i].expireAt <= now) {
      activeFlashMessages.splice(i, 1)
    }
  }
}, 1 * 60 * 1000);
