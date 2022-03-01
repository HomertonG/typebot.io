import { useToast } from '@chakra-ui/react'
import { PublicTypebot, Settings, Theme, Typebot, Webhook } from 'models'
import { Router, useRouter } from 'next/router'
import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  createPublishedTypebot,
  parsePublicTypebotToTypebot,
  parseTypebotToPublicTypebot,
  updatePublishedTypebot,
} from 'services/publicTypebot'
import {
  checkIfPublished,
  checkIfTypebotsAreEqual,
  parseDefaultPublicId,
  updateTypebot,
} from 'services/typebots/typebots'
import { fetcher, preventUserFromRefreshing } from 'services/utils'
import useSWR from 'swr'
import { isDefined, isNotDefined } from 'utils'
import { BlocksActions, blocksActions } from './actions/blocks'
import { stepsAction, StepsActions } from './actions/steps'
import { variablesAction, VariablesActions } from './actions/variables'
import { edgesAction, EdgesActions } from './actions/edges'
import { useRegisterActions } from 'kbar'
import useUndo from 'services/utils/useUndo'
import { useDebounce } from 'use-debounce'
import { itemsAction, ItemsActions } from './actions/items'
import { generate } from 'short-uuid'
import { deepEqual } from 'fast-equals'
import { User } from 'db'
import { saveWebhook } from 'services/webhook'
const autoSaveTimeout = 10000

type UpdateTypebotPayload = Partial<{
  theme: Theme
  settings: Settings
  publicId: string
  name: string
  publishedTypebotId: string
}>

export type SetTypebot = (typebot: Typebot | undefined) => void
const typebotContext = createContext<
  {
    typebot?: Typebot
    publishedTypebot?: PublicTypebot
    owner?: User
    webhooks: Webhook[]
    isReadOnly?: boolean
    isPublished: boolean
    isPublishing: boolean
    isSavingLoading: boolean
    save: () => Promise<void>
    undo: () => void
    redo: () => void
    canRedo: boolean
    canUndo: boolean
    updateWebhook: (
      webhookId: string,
      webhook: Partial<Webhook>
    ) => Promise<void>
    updateTypebot: (updates: UpdateTypebotPayload) => void
    updateOnBothTypebots: (updates: {
      publicId?: string
      name?: string
      customDomain?: string | null
    }) => void
    publishTypebot: () => void
    restorePublishedTypebot: () => void
  } & BlocksActions &
    StepsActions &
    ItemsActions &
    VariablesActions &
    EdgesActions
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //@ts-ignore
>({})

export const TypebotContext = ({
  children,
  typebotId,
}: {
  children: ReactNode
  typebotId: string
}) => {
  const router = useRouter()
  const toast = useToast({
    position: 'top-right',
    status: 'error',
  })

  const {
    typebot,
    publishedTypebot,
    owner,
    webhooks,
    isReadOnly,
    isLoading,
    mutate,
  } = useFetchedTypebot({
    typebotId,
    onError: (error) =>
      toast({
        title: 'Error while fetching typebot',
        description: error.message,
      }),
  })

  const [
    { present: localTypebot },
    {
      redo,
      undo,
      canRedo,
      canUndo,
      set: setLocalTypebot,
      presentRef: currentTypebotRef,
    },
  ] = useUndo<Typebot | undefined>(undefined)

  const saveTypebot = async () => {
    const typebotToSave = currentTypebotRef.current
    if (deepEqual(typebot, typebotToSave)) return
    if (!typebotToSave) return
    setIsSavingLoading(true)
    const { error } = await updateTypebot(typebotToSave.id, typebotToSave)
    setIsSavingLoading(false)
    if (error) {
      toast({ title: error.name, description: error.message })
      return
    }
    mutate({ typebot: typebotToSave, webhooks: webhooks ?? [] })
    window.removeEventListener('beforeunload', preventUserFromRefreshing)
  }

  const savePublishedTypebot = async (newPublishedTypebot: PublicTypebot) => {
    setIsPublishing(true)
    const { error } = await updatePublishedTypebot(
      newPublishedTypebot.id,
      newPublishedTypebot
    )
    setIsPublishing(false)
    if (error) return toast({ title: error.name, description: error.message })
    mutate({
      typebot: currentTypebotRef.current as Typebot,
      publishedTypebot: newPublishedTypebot,
      webhooks: webhooks ?? [],
    })
  }

  useAutoSave({
    handler: saveTypebot,
    item: localTypebot,
    debounceTimeout: autoSaveTimeout,
  })

  useEffect(() => {
    Router.events.on('routeChangeStart', saveTypebot)
    return () => {
      Router.events.off('routeChangeStart', saveTypebot)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [isSavingLoading, setIsSavingLoading] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)

  const isPublished = useMemo(
    () =>
      isDefined(typebot) &&
      isDefined(publishedTypebot) &&
      checkIfPublished(typebot, publishedTypebot),
    [typebot, publishedTypebot]
  )

  useEffect(() => {
    if (!localTypebot || !typebot) return
    currentTypebotRef.current = localTypebot
    if (!checkIfTypebotsAreEqual(localTypebot, typebot)) {
      window.removeEventListener('beforeunload', preventUserFromRefreshing)
      window.addEventListener('beforeunload', preventUserFromRefreshing)
    } else {
      window.removeEventListener('beforeunload', preventUserFromRefreshing)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localTypebot])

  useEffect(() => {
    if (isLoading) return
    if (!typebot) {
      toast({ status: 'info', description: "Couldn't find typebot" })
      router.replace('/typebots')
      return
    }
    setLocalTypebot({ ...typebot })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading])

  useRegisterActions(
    [
      {
        id: 'save',
        name: 'Save typebot',
        perform: () => saveTypebot(),
      },
    ],
    []
  )

  useRegisterActions(
    [
      {
        id: 'undo',
        name: 'Undo changes',
        perform: undo,
      },
    ],
    [localTypebot]
  )

  const updateLocalTypebot = (updates: UpdateTypebotPayload) =>
    localTypebot && setLocalTypebot({ ...localTypebot, ...updates })

  const publishTypebot = async () => {
    if (!localTypebot) return
    const publishedTypebotId = generate()
    const newLocalTypebot = { ...localTypebot }
    if (publishedTypebot && isNotDefined(localTypebot.publishedTypebotId)) {
      updateLocalTypebot({ publishedTypebotId: publishedTypebot.id })
      await saveTypebot()
    }
    if (!publishedTypebot) {
      const newPublicId = parseDefaultPublicId(
        localTypebot.name,
        localTypebot.id
      )
      updateLocalTypebot({ publicId: newPublicId, publishedTypebotId })
      newLocalTypebot.publicId = newPublicId
      await saveTypebot()
    }
    if (publishedTypebot) {
      await savePublishedTypebot({
        ...parseTypebotToPublicTypebot(newLocalTypebot),
        id: publishedTypebot.id,
      })
    } else {
      setIsPublishing(true)
      const { data, error } = await createPublishedTypebot({
        ...parseTypebotToPublicTypebot(newLocalTypebot),
        id: publishedTypebotId,
      })
      setIsPublishing(false)
      if (error) return toast({ title: error.name, description: error.message })
      mutate({
        typebot: localTypebot,
        publishedTypebot: data,
        webhooks: webhooks ?? [],
      })
    }
  }

  const updateOnBothTypebots = async (updates: {
    publicId?: string
    name?: string
    customDomain?: string | null
  }) => {
    updateLocalTypebot(updates)
    await saveTypebot()
    if (!publishedTypebot) return
    await savePublishedTypebot({
      ...publishedTypebot,
      ...updates,
    })
  }

  const restorePublishedTypebot = () => {
    if (!publishedTypebot || !localTypebot) return
    setLocalTypebot(parsePublicTypebotToTypebot(publishedTypebot, localTypebot))
    return saveTypebot()
  }

  const updateWebhook = async (
    webhookId: string,
    updates: Partial<Webhook>
  ) => {
    if (!typebot) return
    const { data } = await saveWebhook(webhookId, updates)
    if (data)
      mutate({
        typebot,
        publishedTypebot,
        webhooks: (webhooks ?? []).map((w) =>
          w.id === webhookId ? data.webhook : w
        ),
      })
  }

  return (
    <typebotContext.Provider
      value={{
        typebot: localTypebot,
        publishedTypebot,
        owner,
        webhooks: webhooks ?? [],
        isReadOnly,
        isSavingLoading,
        save: saveTypebot,
        undo,
        redo,
        canUndo,
        canRedo,
        publishTypebot,
        isPublishing,
        isPublished,
        updateTypebot: updateLocalTypebot,
        restorePublishedTypebot,
        updateOnBothTypebots,
        updateWebhook,
        ...blocksActions(localTypebot as Typebot, setLocalTypebot),
        ...stepsAction(localTypebot as Typebot, setLocalTypebot),
        ...variablesAction(localTypebot as Typebot, setLocalTypebot),
        ...edgesAction(localTypebot as Typebot, setLocalTypebot),
        ...itemsAction(localTypebot as Typebot, setLocalTypebot),
      }}
    >
      {children}
    </typebotContext.Provider>
  )
}

export const useTypebot = () => useContext(typebotContext)

export const useFetchedTypebot = ({
  typebotId,
  onError,
}: {
  typebotId: string
  onError: (error: Error) => void
}) => {
  const { data, error, mutate } = useSWR<
    {
      typebot: Typebot
      webhooks: Webhook[]
      publishedTypebot?: PublicTypebot
      owner?: User
      isReadOnly?: boolean
    },
    Error
  >(`/api/typebots/${typebotId}`, fetcher)
  if (error) onError(error)
  return {
    typebot: data?.typebot,
    webhooks: data?.webhooks,
    publishedTypebot: data?.publishedTypebot,
    owner: data?.owner,
    isReadOnly: data?.isReadOnly,
    isLoading: !error && !data,
    mutate,
  }
}

const useAutoSave = <T,>({
  handler,
  item,
  debounceTimeout,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (item?: T) => Promise<any>
  item?: T
  debounceTimeout: number
}) => {
  const [debouncedItem] = useDebounce(item, debounceTimeout)
  useEffect(() => {
    const save = () => handler(item)
    document.addEventListener('visibilitychange', save)
    return () => {
      document.removeEventListener('visibilitychange', save)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return useEffect(() => {
    handler(item)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedItem])
}
