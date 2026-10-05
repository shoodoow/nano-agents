import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

/** System photo library UI (PHPicker on iOS, Photo Picker on Android). */
export function imageLibraryPickerOptions(quality = 0.7): ImagePicker.ImagePickerOptions {
  return {
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    base64: true,
    quality,
    legacy: false,
    ...(Platform.OS === "ios"
      ? {
          presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
          preferredAssetRepresentationMode:
            ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Automatic,
        }
      : { defaultTab: "photos" }),
  };
}

/** System camera UI. */
export function cameraPickerOptions(quality = 0.7): ImagePicker.ImagePickerOptions {
  return {
    mediaTypes: ["images"],
    allowsEditing: false,
    base64: true,
    quality,
    ...(Platform.OS === "ios"
      ? {
          presentationStyle: ImagePicker.UIImagePickerPresentationStyle.FULL_SCREEN,
          cameraType: ImagePicker.CameraType.back,
        }
      : { cameraType: ImagePicker.CameraType.back }),
  };
}
