let creatingDoc = false;
const main = async () => {
  if (creatingDoc) return;
  creatingDoc = true;
  try {
    if (await chrome.offscreen.hasDocument()) {
      creatingDoc = false;
      return;
    }
    await chrome.offscreen.createDocument({
      url: "backgroundPage.html",
      // reasons: ["CLIPBOARD"],
      reasons: [chrome.offscreen.Reason["LOCAL_STORAGE"] || chrome.offscreen.Reason["CLIPBOARD"]],
      justification: "audio playback & local storage use & clipboard use", // details for using the API
    });

    console.log("created offscreen background page");
  } catch (error) {
    console.error(error);
  }
  creatingDoc = false;
};
main();

//run on startup
chrome.runtime.onStartup.addListener(() => main());

// Return current cities
chrome.runtime.onMessage.addListener((value, sender, sendResponse) => {
  const { type, data } = value;
  switch (type) {
    case "STORAGE_GET":
      chrome.storage.sync.get(data, (v) => {
        sendResponse(v);
      });
      return true;

    case "STORAGE_SET":
      chrome.storage.sync.set(data, (v) => {
        sendResponse(v);
      });
      return true;

    case "NOTIFICATION_CREATE":
      return sendResponse(chrome.notifications.create(data));

    case "CREATE_WINDOW":
      chrome.windows.create(data, (v) => {
        if (chrome.runtime.lastError) return sendResponse();
        sendResponse(v);
      });
      return true;

    case "UPDATE_WINDOW":
      chrome.windows.update(...data, (v) => {
        if (chrome.runtime.lastError) return sendResponse();
        sendResponse(v);
      });
      return true;
  }
});

chrome.notifications.onButtonClicked.addListener((...data) => {
  chrome.runtime.sendMessage({ type: "NOTIFICATION_CLICKED", data });
});
