import { googleMapsUrl, plainCoordinates } from "../maps";

/** Opens the point in Google Maps, in a new tab. */
export default function MapsLink({ latitude, longitude }: { latitude: number; longitude: number }) {
  const url = googleMapsUrl(latitude, longitude);
  if (!url) return null;
  return (
    <a
      className="turn__show maps-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${plainCoordinates(latitude, longitude)} in Google Maps`}
    >
      Google Maps ↗
    </a>
  );
}
