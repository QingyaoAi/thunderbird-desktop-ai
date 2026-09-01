/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef COMM_MAILNEWS_IMAP_SRC_NSIMAPFLAGANDUIDSTATE_H_
#define COMM_MAILNEWS_IMAP_SRC_NSIMAPFLAGANDUIDSTATE_H_

#include "MailNewsTypes2.h"
#include "nsIImapFlagAndUidState.h"
#include "nsImapCore.h"
#include "nsTArray.h"
#include "nsTHashMap.h"
#include "mozilla/Mutex.h"

const int32_t kImapFlagAndUidStateSize = 100;

class nsImapFlagAndUidState : public nsIImapFlagAndUidState {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  explicit nsImapFlagAndUidState(int numberOfMessages);

  NS_DECL_NSIIMAPFLAGANDUIDSTATE

  int32_t NumberOfDeletedMessages();

  imapMessageFlagsType GetMessageFlagsFromUID(ImapUid uid, bool* foundIt,
                                              int32_t* ndx);

  bool IsLastMessageUnseen(void);
  bool GetPartialUIDFetch() { return fPartialUIDFetch; }
  void SetPartialUIDFetch(bool isPartial) { fPartialUIDFetch = isPartial; }
  ImapUid GetHighestNonDeletedUID();
  uint16_t GetSupportedUserFlags() { return fSupportedUserFlags; }
  void StartCapture() { fStartCapture = true; }
  uint32_t GetNumAdded() { return fNumAdded; }

  /**
   * What this connection is holding for the mailbox it has selected: a UID and
   * a flag word for every message in it, plus whatever keywords the server
   * reports per message -- Gmail's labels arrive this way.
   *
   * Takes mLock, because the IMAP thread writes these while the main thread is
   * the one that asks.
   */
  size_t SizeOfIncludingThis(mozilla::MallocSizeOf aMallocSizeOf);

 private:
  virtual ~nsImapFlagAndUidState();

  nsTArray<ImapUid> fUids;
  nsTArray<imapMessageFlagsType> fFlags;
  // Hash table, mapping uids to extra flags
  nsTHashMap<nsUint32HashKey, nsCString> m_customFlagsHash;
  // Hash table, mapping UID+customAttributeName to customAttributeValue.
  nsTHashMap<nsCStringHashKey, nsCString> m_customAttributesHash;
  uint16_t fSupportedUserFlags;
  int32_t fNumberDeleted;
  bool fPartialUIDFetch;
  uint32_t fNumAdded;
  bool fStartCapture;
  mozilla::Mutex mLock;
};

#endif  // COMM_MAILNEWS_IMAP_SRC_NSIMAPFLAGANDUIDSTATE_H_
